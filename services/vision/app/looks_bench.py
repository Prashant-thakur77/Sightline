"""SightBench looks bench: two looks before "sure", quote-or-unsure reads, one simulated retake.

    python -m app.looks_bench --split test --manifest ../../evals/sightbench/manifests/test.json \
        --first-cache ../../evals/data/raw/sightbench/responses/with-model/fitted-dev-2026-11-09 \
        --retakes ../../evals/sightbench/manifests/retake-test.json --sample 120 --budget-usd 12 --out rows.json

Per pair it records several systems, all scored later by evals/sightbench/looks.ts:

- ``current``: the verdict saved by the last with-model test run (``--first-cache``), unchanged.
- ``replayOld``: that run's module outputs fused again with the rule from before two looks
  (``mismatch_min_signals`` 1). Must equal ``current``; it proves the re-scoring is faithful.
- ``twoLooks``: the same module outputs fused with the two-looks rule. No new model call.
- ``quoted``: a fresh first look whose identity and damage reads use the quote-or-unsure prompts
  and schema (``vlm.PROMPT_VERSION``). The size-tag read is reused from ``--first-cache`` when there
  is one (its prompt did not change); colour, OCR and quality are recomputed (deterministic).
- ``quotedRetake``: when ``quoted`` is "not sure" and asks for an extra shot, the SIMULATED retake
  photo of that kind (``--retakes``) is checked and combined with the first look
  (``pipeline.second_look_modules`` and ``looks.combine_looks``, as POST /recheck does).

``quoted`` and ``quotedRetake`` run only for ``--sample`` pairs (stratified by truth, mismatch type
and light, in a fixed hash order), because they need new model calls. Every new model read is
cached under ``--cache`` by prompt version, model and effort, so re-running never pays twice and
never reuses a read made with other wording. Spend is counted from the API's token usage at the
model's list price into ``--ledger``; before each new call the bench stops if the next call could
take the ledger past ``--budget-usd``. Pairs not reached are reported as not run.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import threading
import time
from collections.abc import Callable, Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from . import fusion, looks
from . import vlm as vlm_mod
from .config import Limits, load_thresholds
from .imageio import decode, sanitize
from .label import get_ocr_engine
from .pipeline import LABEL_MAX_SIDE, VerifyInputs, run_verify, second_look_modules
from .vlm import ImagePart, VlmUnavailable, get_vlm_client

# USD per million tokens (input, output), list price. Thinking tokens are billed as output.
PRICES = {"claude-opus-5-5": (4.0, 20.0)}
# Assumed cost of the next uncached call when checking the cap (a dear identity read with headroom).
NEXT_CALL_USD = 0.06


class BudgetExhausted(BaseException):  # noqa: N818
    """Not an Exception, so the pipeline's per-module guard cannot turn it into an "unknown" finding."""


class Ledger:
    """Money spent on new model reads, kept on disk across runs.

    Several bench processes may share one ledger (``--shard``): every read and write of the file
    happens under an exclusive file lock, after re-reading it, so no process loses another's spend.
    """

    def __init__(self, path: Path, cap_usd: float) -> None:
        self.path = path
        self.cap = cap_usd
        self.lock = threading.Lock()
        self.data = self._read()

    def _read(self) -> dict[str, Any]:
        if self.path.exists():
            return json.loads(self.path.read_text())
        return {"usd": 0.0, "calls": 0, "input_tokens": 0, "output_tokens": 0, "runs": []}

    def _locked(self, fn: Callable[[dict[str, Any]], None] | None = None) -> None:
        import fcntl

        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.lock, open(self.path.with_suffix(".lock"), "w") as lock_file:
            fcntl.flock(lock_file, fcntl.LOCK_EX)
            self.data = self._read()
            if fn is not None:
                fn(self.data)
                self.path.write_text(json.dumps(self.data, indent=2) + "\n")

    def check(self) -> None:
        self._locked()
        if self.data["usd"] + NEXT_CALL_USD > self.cap:
            raise BudgetExhausted(f"spent {self.data['usd']:.2f} of {self.cap:.2f} USD")

    def add(self, usd: float, input_tokens: int, output_tokens: int) -> None:
        def apply(d: dict[str, Any]) -> None:
            d["usd"] = round(d["usd"] + usd, 6)
            d["calls"] += 1
            d["input_tokens"] += input_tokens
            d["output_tokens"] += output_tokens

        self._locked(apply)

    def add_run(self, run: dict[str, Any]) -> None:
        self._locked(lambda d: d["runs"].append(run))


class CachingVlm:
    """Wraps the real client: one cache file per (pair, look, read); new reads are paid for once.

    Calls are serialised, so the token count of each call is the change in the client's totals.
    """

    def __init__(self, inner: Any, cache_dir: Path, prefix: str, ledger: Ledger, model: str, offline: bool) -> None:
        self.inner = inner
        self.name = inner.name
        self.available = inner.available
        self.cache_dir = cache_dir
        self.prefix = prefix
        self.ledger = ledger
        self.model = model
        self.offline = offline
        self.lock = threading.Lock()
        self.new_calls = 0

    def _get(self, method: str, fn: Callable[[], dict[str, Any]]) -> dict[str, Any]:
        path = self.cache_dir / f"{self.prefix}__{method}.json"
        with self.lock:
            if path.exists():
                cached = json.loads(path.read_text())
                if "error" in cached:
                    raise VlmUnavailable(cached["error"])
                return cached["data"]
            if self.offline or not self.inner.available:
                raise VlmUnavailable("not cached")
            self.ledger.check()
            before = dict(self.inner.usage)
            try:
                data = fn()
                record: dict[str, Any] = {"data": data}
            except VlmUnavailable as exc:
                data, record = None, {"error": str(exc)}
            after = self.inner.usage
            tin = after["input_tokens"] - before["input_tokens"]
            tout = after["output_tokens"] - before["output_tokens"]
            pin, pout = PRICES.get(self.model, (4.0, 20.0))
            usd = (tin * pin + tout * pout) / 1e6
            self.ledger.add(usd, tin, tout)
            self.new_calls += 1
            record.update({"usage": {"input_tokens": tin, "output_tokens": tout, "usd": round(usd, 6)}, "model": self.model})
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(record))
            if data is None:
                raise VlmUnavailable(record["error"])
            return data

    def read_label(self, image: ImagePart) -> dict[str, Any]:
        return self._get("label", lambda: self.inner.read_label(image))

    def compare_identity(self, item: Sequence[ImagePart], listing: Sequence[ImagePart], listing_info: dict[str, Any]) -> dict[str, Any]:
        return self._get("identity", lambda: self.inner.compare_identity(item, listing, listing_info))

    def check_damage(self, images: Sequence[ImagePart]) -> dict[str, Any]:
        return self._get("damage", lambda: self.inner.check_damage(images))


def load_model_env(path: Path) -> None:
    """Only the model settings are taken from the file; nothing else in it is read into the process."""
    for line in path.read_text().splitlines():
        key, sep, value = line.partition("=")
        if sep and key.strip() in ("VISION_MODEL", "VISION_EFFORT", "ANTHROPIC_API_KEY") and value.strip():
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def seed_label(cache_dir: Path, prefix: str, size_module: dict[str, Any] | None) -> bool:
    """Reuse a saved size-tag read (its prompt is unchanged) as this look's cached label read."""
    a = (size_module or {}).get("read_a") or {}
    if not a.get("available") or "error" in a or "size_raw" not in a:
        return False
    path = cache_dir / f"{prefix}__label.json"
    if not path.exists():
        data = {k: a.get(k, "") for k in ("brand", "material", "raw_text")}
        data.update({"size": a["size_raw"], "boxes": a.get("boxes") or []})
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"data": data, "reused_from": "first-cache read_a", "usage": {"usd": 0}}))
    return True


def stratified_sample(pairs: list[dict[str, Any]], n: int) -> list[str]:
    """``n`` pair ids spread over (truth, mismatch type, light) cells, in a fixed hash order."""
    cells: dict[tuple[str, str, str], list[dict[str, Any]]] = {}
    for p in pairs:
        cells.setdefault((p["expected"], p.get("mismatch_type") or "-", p["lighting"]), []).append(p)
    for v in cells.values():
        v.sort(key=lambda p: hashlib.sha256(p["id"].encode()).hexdigest())
    # Half the sample from matching pairs, half from mismatches, as in the split itself.
    keys = sorted(cells)
    match_keys = [k for k in keys if k[0] == "match"]
    mm_keys = [k for k in keys if k[0] == "mismatch"]
    picked: list[str] = []
    for group, quota in ((match_keys, n // 2), (mm_keys, n - n // 2)):
        i = 0
        taken = 0
        while taken < quota and any(cells[k] for k in group):
            k = group[i % len(group)]
            if cells[k]:
                picked.append(cells[k].pop(0)["id"])
                taken += 1
            i += 1
    return picked


def _summary(verdict: dict[str, Any]) -> dict[str, Any]:
    return {
        "kind": verdict["kind"],
        "disagree": [r["module"] for r in verdict["reasons"] if r["finding"] == "disagree"],
        "retake": (verdict.get("retake") or {}).get("kind"),
        "retakeModule": (verdict.get("retake") or {}).get("module"),
        "signals": verdict.get("signals"),
    }


def _modules_of(body: dict[str, Any]) -> dict[str, Any]:
    m = body["modules"]
    return {k: m.get(k) for k in ("colour", "size", "identity", "damage")} | {"quality": m.get("quality")}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m app.looks_bench", description=__doc__.split("\n")[0])
    ap.add_argument("--split", required=True)
    ap.add_argument("--manifest", required=True, type=Path)
    ap.add_argument("--first-cache", type=Path, help="Saved /verify responses of the last with-model run of this split.")
    ap.add_argument("--retakes", type=Path, help="Simulated retake manifest (evals/sightbench/manifests/retake-<split>.json).")
    ap.add_argument("--sample", type=int, default=0, help="Pairs that get new quote-or-unsure reads and a simulated retake.")
    ap.add_argument("--cache", type=Path, required=True, help="Directory for new model reads (a subfolder per prompt version).")
    ap.add_argument("--ledger", type=Path, required=True)
    ap.add_argument("--budget-usd", type=float, required=True)
    ap.add_argument("--offline", action="store_true", help="Never call the model; only cached reads.")
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--env-file", type=Path, help="Read VISION_MODEL, VISION_EFFORT and ANTHROPIC_API_KEY from this dotenv file.")
    ap.add_argument(
        "--shard", default="0/1", help="i/k: make new reads only for every k-th sampled pair from i (parallel runs share the ledger)."
    )
    ap.add_argument(
        "--write-responses",
        type=Path,
        help="Write each sampled pair's first look (two looks, quoted reads) as a saved /verify response here, for sightbench/run.ts --reuse.",
    )
    args = ap.parse_args(argv)
    shard_i, shard_k = (int(x) for x in args.shard.split("/"))
    if args.env_file:
        load_model_env(args.env_file)

    manifest = json.loads(args.manifest.read_text())
    base = args.manifest.parent
    pairs = manifest["pairs"]
    th = load_thresholds()
    fth = th["fusion"]
    inner = get_vlm_client()
    model = getattr(inner, "model", "none")
    effort = getattr(inner, "effort", None)
    if args.sample and model == "none":
        # The read cache is keyed by model and effort: without them every read would look uncached.
        ap.error("--sample needs the model settings (--env-file or VISION_MODEL), also with --offline")
    ocr = get_ocr_engine()
    ledger = Ledger(args.ledger, args.budget_usd)
    reads_dir = args.cache / f"{vlm_mod.PROMPT_VERSION}__{model}__{effort}"
    retakes = {}
    if args.retakes:
        rm = json.loads(args.retakes.read_text())
        retakes = {r["id"]: {k: (args.retakes.parent / v["path"]).resolve() for k, v in r["files"].items()} for r in rm["pairs"]}
    sample = stratified_sample(pairs, args.sample) if args.sample else []
    sample_set = set(sample)
    mine = {pid for j, pid in enumerate(sample) if j % shard_k == shard_i}
    spent_before = ledger.data["usd"]
    started = time.time()
    rows: list[dict[str, Any]] = []
    stopped: str | None = None
    for i, pair in enumerate(pairs, 1):
        row: dict[str, Any] = {
            "id": pair["id"],
            "expected": pair["expected"],
            "mismatchType": pair.get("mismatch_type"),
            "subtype": pair.get("mismatch_subtype"),
            "lighting": pair["lighting"],
            "productType": pair.get("product_type"),
            "inSample": pair["id"] in sample_set,
        }
        listing = pair["listing"]
        old_body = None
        if args.first_cache and (args.first_cache / f"{pair['id']}.json").exists():
            saved = json.loads((args.first_cache / f"{pair['id']}.json").read_text())
            if saved.get("status") == 200 and saved.get("body", {}).get("verdict"):
                old_body = saved["body"]
        if old_body is not None:
            old_modules = _modules_of(old_body)
            row["current"] = _summary(old_body["verdict"])
            row["replayOld"] = fusion.fuse(old_modules, listing, {**fth, "mismatch_min_signals": 1})["kind"]
            row["twoLooks"] = _summary(fusion.fuse(old_modules, listing, fth))
        if pair["id"] in sample_set and pair["id"] not in mine:
            row["notRun"] = "other shard"
        elif pair["id"] in sample_set and stopped is None:
            try:
                prefix = f"{pair['id']}__look1"
                cvlm = CachingVlm(inner, reads_dir, prefix, ledger, model, args.offline)
                if old_body is not None:
                    seed_label(reads_dir, prefix, old_body["modules"].get("size"))
                inputs = VerifyInputs(
                    item_photos=[sanitize((base / p).read_bytes()) for p in pair["item"]],
                    label_photo=sanitize((base / pair["label"]).read_bytes()) if pair.get("label") else None,
                    damage_photo=None,
                    listing_images=[sanitize((base / p).read_bytes()) for p in pair["listing_images"]],
                    listing=listing,
                )
                first = run_verify(inputs, vlm=cvlm, ocr=ocr, th=th)
                v1 = first["verdict"]
                row["quoted"] = _summary(v1)
                if args.write_responses:
                    # Same shape as a saved POST /verify response. No latency: the reads came from the cache.
                    args.write_responses.mkdir(parents=True, exist_ok=True)
                    saved_body = {"status": 200, "ms": None, "body": first, "source": "app.looks_bench (cached model reads)"}
                    (args.write_responses / f"{pair['id']}.json").write_text(json.dumps(saved_body))
                ident, dmg = first["modules"].get("identity") or {}, first["modules"].get("damage") or {}
                row["quotedReads"] = {
                    "identity": {"finding": ident.get("finding"), "confidence": ident.get("confidence"), "reason": ident.get("reason")},
                    "damage": {"finding": dmg.get("finding"), "confidence": dmg.get("confidence"), "uncited": dmg.get("uncited") or []},
                }
                kind = (v1.get("retake") or {}).get("kind")
                if kind and pair["id"] in retakes and kind in retakes[pair["id"]]:
                    rgb = decode(
                        sanitize(retakes[pair["id"]][kind].read_bytes()).data, LABEL_MAX_SIDE if kind == "tag" else Limits.verify_max_side
                    )
                    listing_rgbs = [decode(s.data, Limits.verify_max_side) for s in inputs.listing_images]
                    rvlm = CachingVlm(inner, reads_dir, f"{pair['id']}__{kind}", ledger, model, args.offline)
                    second = second_look_modules(kind, rgb, listing_rgbs, listing, rvlm, ocr, th)
                    combined = looks.combine_looks(_modules_of(first), second, kind)
                    row["quotedRetake"] = {**_summary(fusion.fuse(combined, listing, fth)), "retakeKind": kind}
                else:
                    # Nothing asked for, or no retake of that kind: the first answer stands.
                    row["quotedRetake"] = {**row["quoted"], "retakeKind": None}
            except BudgetExhausted as exc:
                stopped = f"budget: {exc} at pair {pair['id']}"
                row.pop("quoted", None)
                row.pop("quotedReads", None)
                row["notRun"] = "budget"
        elif pair["id"] in sample_set:
            row["notRun"] = "budget"
        rows.append(row)
        if i % 25 == 0:
            print(f"  {i}/{len(pairs)}  spent {ledger.data['usd'] - spent_before:.2f} USD this run", flush=True)

    run = {
        "at": datetime.now(UTC).isoformat(timespec="seconds"),
        "split": args.split,
        "sample": len(sample),
        "usd": round(ledger.data["usd"] - spent_before, 4),
        "stopped": stopped,
    }
    ledger.add_run({**run, "shard": args.shard})
    out = {
        "split": args.split,
        "manifest": str(args.manifest),
        "generatedAt": run["at"],
        "thresholds": th.get("version"),
        "promptVersion": vlm_mod.PROMPT_VERSION,
        "model": model,
        "effort": effort,
        "sample": sample,
        "spend": {
            "thisRunUsd": run["usd"],
            "ledgerUsd": ledger.data["usd"],
            "ledgerCalls": ledger.data["calls"],
            "capUsd": args.budget_usd,
            "prices": PRICES,
        },
        "stopped": stopped,
        "seconds": round(time.time() - started, 1),
        "rows": rows,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out, indent=1) + "\n")
    print(
        f"looks_bench: {len(rows)} pairs, sample {len(sample)}, spent {run['usd']:.2f} USD (ledger {ledger.data['usd']:.2f}) -> {args.out}"
    )
    if stopped:
        print(f"looks_bench: stopped early ({stopped})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
