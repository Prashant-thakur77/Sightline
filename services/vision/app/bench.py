"""Benchmark runner: ``python -m app.bench --manifest <path> [--out <path>]``.

Runs the /verify logic over a manifest of (delivered photos, listing) pairs and writes metrics as
JSON. Paths in the manifest are relative to the manifest file. Manifest format::

    {
      "name": "sightbench-dev",
      "pairs": [
        {
          "id": "p001",
          "item": ["items/p001_a.jpg"],          # one or more photos of the delivered item
          "label": "labels/p001.jpg",           # optional size tag photo
          "damage": null,                        # optional damage close-up
          "listing_images": ["listing/p001.jpg"],
          "listing": {"title": "...", "colour": "navy", "size": "M", "attributes": {}},
          "expected": "match",                   # or "mismatch"
          "mismatch_type": null,                 # "colour" | "size" | "model" | "damage" when mismatch
          "lighting": "good"                     # free-form condition label, e.g. good | dim | warm
        }
      ]
    }

Metrics: mismatch recall (mismatches flagged as mismatch), false-alarm rate (matches flagged as
mismatch), abstention rate (unsure), accuracy when not abstaining, match rate on true matches; each
overall, per mismatch type and per lighting condition, with Wilson 95% intervals; p50/p95 latency.
"""

from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .config import load_thresholds
from .imageio import SanitizedImage, sanitize
from .pipeline import MODULES, VerifyInputs, run_verify
from .vlm import NullVlmClient, get_vlm_client


def wilson(successes: int, n: int, z: float = 1.959964) -> list[float] | None:
    if n == 0:
        return None
    p = successes / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return [round(max(0.0, centre - half), 4), round(min(1.0, centre + half), 4)]


def _rate(k: int, n: int) -> dict[str, Any]:
    return {"value": round(k / n, 4) if n else None, "k": k, "n": n, "ci95": wilson(k, n)}


def _percentile(values: list[float], q: float) -> float | None:
    if not values:
        return None
    s = sorted(values)
    idx = min(len(s) - 1, max(0, math.ceil(q / 100 * len(s)) - 1))
    return round(s[idx], 1)


def summarise(rows: list[dict[str, Any]]) -> dict[str, Any]:
    mism = [r for r in rows if r["expected"] == "mismatch"]
    match = [r for r in rows if r["expected"] == "match"]
    decided = [r for r in rows if r["predicted"] in ("match", "mismatch")]
    return {
        "n": len(rows),
        "mismatch_recall": _rate(sum(r["predicted"] == "mismatch" for r in mism), len(mism)),
        "false_alarm_rate": _rate(sum(r["predicted"] == "mismatch" for r in match), len(match)),
        "match_rate": _rate(sum(r["predicted"] == "match" for r in match), len(match)),
        "abstention_rate": _rate(sum(r["predicted"] == "unsure" for r in rows), len(rows)),
        "accuracy_when_decided": _rate(sum(r["predicted"] == r["expected"] for r in decided), len(decided)),
        "wrong_match_rate": _rate(sum(r["predicted"] == "match" for r in mism), len(mism)),
    }


def compute_metrics(rows: list[dict[str, Any]]) -> dict[str, Any]:
    by_type: dict[str, list[dict[str, Any]]] = {}
    for r in rows:
        if r["expected"] == "mismatch":
            by_type.setdefault(r.get("mismatch_type") or "unspecified", []).append(r)
    by_light: dict[str, list[dict[str, Any]]] = {}
    for r in rows:
        by_light.setdefault(r.get("lighting") or "unspecified", []).append(r)
    latencies = [r["ms"] for r in rows if r.get("ms") is not None]
    return {
        "overall": summarise(rows),
        "per_mismatch_type": {k: summarise(v) for k, v in sorted(by_type.items())},
        "per_lighting": {k: summarise(v) for k, v in sorted(by_light.items())},
        "latency_ms": {"p50": _percentile(latencies, 50), "p95": _percentile(latencies, 95)},
        "errors": sum(1 for r in rows if r.get("error")),
    }


def _load(base: Path, rel: str | None) -> SanitizedImage | None:
    if not rel:
        return None
    path = (base / rel).resolve()
    return sanitize(path.read_bytes())


def _as_list(value: Any) -> list[str]:
    if value is None:
        return []
    return [value] if isinstance(value, str) else list(value)


def _git_sha() -> str | None:
    try:
        out = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True, timeout=5, check=False)
        return out.stdout.strip() or None
    except (OSError, subprocess.SubprocessError):
        return None


def run_manifest(
    manifest_path: Path, use_vlm: bool = True, disabled: set[str] | None = None, thresholds_path: str | None = None
) -> dict[str, Any]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    pairs = manifest["pairs"] if isinstance(manifest, dict) else manifest
    base = manifest_path.parent
    th = load_thresholds(thresholds_path)
    vlm = get_vlm_client() if use_vlm else NullVlmClient()
    rows: list[dict[str, Any]] = []
    for pair in pairs:
        row: dict[str, Any] = {
            "id": pair.get("id"),
            "expected": pair.get("expected"),
            "mismatch_type": pair.get("mismatch_type"),
            "lighting": pair.get("lighting"),
        }
        try:
            inputs = VerifyInputs(
                item_photos=[s for s in (_load(base, p) for p in _as_list(pair.get("item"))) if s],
                label_photo=_load(base, pair.get("label")),
                damage_photo=_load(base, pair.get("damage")),
                listing_images=[s for s in (_load(base, p) for p in _as_list(pair.get("listing_images"))) if s],
                listing=pair.get("listing") or {},
            )
            start = time.perf_counter()
            result = run_verify(inputs, vlm=vlm, th=th, disabled=frozenset(disabled or ()))
            row["ms"] = round((time.perf_counter() - start) * 1000.0, 1)
            verdict = result["verdict"]
            row["predicted"] = verdict["kind"]
            row["headline"] = verdict["headline"]
            row["reasons"] = [{k: r[k] for k in ("module", "finding", "confidence")} for r in verdict["reasons"]]
            row["timings_ms"] = result["timings_ms"]
        except Exception as exc:  # noqa: BLE001 - one bad pair must not stop the run
            row["predicted"] = "unsure"
            row["error"] = f"{type(exc).__name__}: {exc}"
        rows.append(row)
    return {
        "suite": manifest.get("name") if isinstance(manifest, dict) else None,
        "manifest": str(manifest_path),
        "generated_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "git_sha": _git_sha(),
        "thresholds_version": th.get("version"),
        "engines": {"vlm": vlm.name},
        "disabled_modules": sorted(disabled or ()),
        "metrics": compute_metrics(rows),
        "pairs": rows,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.bench", description=__doc__.split("\n")[0])
    parser.add_argument("--manifest", required=True, type=Path, help="Manifest JSON of pairs.")
    parser.add_argument("--out", type=Path, help="Where to write the metrics JSON (default: stdout).")
    parser.add_argument("--no-vlm", action="store_true", help="Run without the vision model (OCR, colour and quality only).")
    parser.add_argument("--disable", default="", help=f"Comma-separated modules to switch off for ablations: {', '.join(MODULES)}.")
    parser.add_argument("--thresholds", help="Thresholds override JSON (only the keys that change).")
    args = parser.parse_args(argv)
    disabled = {m.strip() for m in args.disable.split(",") if m.strip()}
    unknown = disabled - set(MODULES)
    if unknown:
        parser.error(f"unknown module(s): {', '.join(sorted(unknown))}")
    report = run_manifest(args.manifest, use_vlm=not args.no_vlm, disabled=disabled, thresholds_path=args.thresholds)
    text = json.dumps(report, indent=2)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(text + "\n", encoding="utf-8")
        overall = report["metrics"]["overall"]
        print(
            f"{overall['n']} pairs: mismatch recall {overall['mismatch_recall']['value']}, "
            f"false alarms {overall['false_alarm_rate']['value']}, abstention {overall['abstention_rate']['value']} -> {args.out}"
        )
    else:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
