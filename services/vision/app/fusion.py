"""Fusion: turns module outputs into one verdict with plain-language reasons.

Rules (thresholds in ``thresholds.json`` -> ``fusion``):

- ``mismatch`` needs at least one disagreeing reason at ``sure`` confidence.
- Any other disagreement gives ``unsure``.
- ``match`` needs every required module that applies to this listing (colour, size, identity by
  default) to agree at its minimum confidence, no disagreement anywhere, and a usable item photo.
- Everything else is ``unsure``, with next steps (better light, a closer tag photo, a helper).

Output follows the shared ``Verdict`` type; field names are snake_case (``next_steps`` is
``nextSteps`` in TypeScript). ``expected`` and ``observed`` are omitted when unknown. Sentences use
confidence words, never percentages.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from .damage import KIND_NOUNS

CONF_RANK = {"not_sure": 0, "fairly_sure": 1, "sure": 2}
MODULE_ORDER = ("size", "colour", "identity", "damage", "quality")
FINDING_ORDER = {"disagree": 0, "unknown": 1, "agree": 2}

QUALITY_SENTENCES = {
    "TOO_DARK": "The photo is dark, so some checks are less certain.",
    "BLURRY": "The photo is a little blurry, so some checks are less certain.",
    "GLARE": "There's glare in the photo, so some checks are less certain.",
    "TOO_FAR": "The item is small in the photo, so some checks are less certain.",
    "TOO_CLOSE": "The item doesn't fit in the photo, so some checks are less certain.",
}

STEP_LIGHT = "Try again near a window or under a bright light."
STEP_WHITE_LIGHT = "Try again in daylight or under a plain white light."
STEP_TAG = "Take a close photo of the size tag, flat and in good light."
STEP_DAMAGE = "Take a close photo of the spot that might be damaged."
STEP_HELPER = "Or ask a helper to look."
STEP_HELPER_COLOUR = "Ask a helper to check the colour."
STEP_HELPER_SIZE = "Ask a helper to check the size."
STEP_HELPER_ITEM = "Ask a helper to check that it's the same item."
STEPS_MISMATCH = [
    "Keep the item, its tags and the packaging as they are.",
    "I can help you ask the seller for your money back.",
]


@dataclass
class Reason:
    module: str
    finding: str
    confidence: str
    sentence: str
    expected: str | None = None
    observed: str | None = None
    applicable: bool = True
    steps: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {"module": self.module, "finding": self.finding, "confidence": self.confidence}
        if self.expected is not None:
            d["expected"] = self.expected
        if self.observed is not None:
            d["observed"] = self.observed
        d["sentence"] = self.sentence
        return d


def product_noun(listing: dict[str, Any], identity: dict[str, Any] | None = None) -> str:
    attrs = listing.get("attributes") or {}
    for key in ("type", "product_type", "category"):
        value = attrs.get(key) if isinstance(attrs, dict) else None
        if isinstance(value, str) and value.strip():
            return value.strip().lower()
    if identity and identity.get("product_type_listing"):
        return str(identity["product_type_listing"]).strip().lower()
    title = str(listing.get("title") or "")
    words = re.findall(r"[A-Za-z]+", title)
    return words[-1].lower() if words else "item"


def _less_sure_clause(light_reasons: list[str], confidence: str) -> str:
    if "dim" in light_reasons:
        return ", but the light is dim so I'm less sure."
    if "colour_cast" in light_reasons:
        return ", but the light is tinted so I'm less sure."
    if "glare" in light_reasons:
        return ", but there's glare on it so I'm less sure."
    return ", but I'm only fairly sure." if confidence == "fairly_sure" else ", but I'm not sure."


# --------------------------------------------------------------------------------------------
# Per-module reasons
# --------------------------------------------------------------------------------------------


def _colour_reason(c: dict[str, Any], listing: dict[str, Any]) -> Reason:
    listed = (listing.get("colour") or "").strip().lower() or None
    expected = listed or c.get("expected_name")
    observed = c.get("observed_name")
    finding, conf = c.get("finding", "unknown"), c.get("confidence", "not_sure")
    light = list(c.get("light_reasons") or [])
    abstain = c.get("abstain_reason")
    # A module that failed still applies: it must block a match, not be skipped.
    applicable = abstain != "nothing_to_compare"
    r = Reason("colour", finding, conf, "", expected=expected, observed=observed, applicable=applicable)

    if finding == "disagree":
        same_name = observed and expected and observed == c.get("expected_name")
        phrase = (
            "The colour looks different from the listing photo"
            if (same_name or not expected)
            else f"The colour looks {observed}, not {expected}"
        )
        r.sentence = phrase + (". I'm sure about that." if conf == "sure" else _less_sure_clause(light, conf))
        if conf != "sure":
            r.steps.append(STEP_LIGHT if "dim" in light else (STEP_WHITE_LIGHT if "colour_cast" in light else STEP_HELPER_COLOUR))
    elif finding == "agree":
        # The colour fits the listed name, so that is what was observed (the nearest table name,
        # e.g. "denim" for a light navy, stays in the module output).
        r.observed = expected or observed
        what = expected or "the listing photo"
        base = f"The colour looks {what}, as listed" if expected else "The colour looks the same as the listing photo"
        if conf == "sure":
            r.sentence = base + "."
        elif light:
            r.sentence = base + _less_sure_clause(light, conf)
        else:
            r.sentence = base + (". I'm fairly sure." if conf == "fairly_sure" else ", but I'm not sure.")
        if CONF_RANK[conf] < CONF_RANK["fairly_sure"]:
            r.steps.append(STEP_LIGHT if "dim" in light else STEP_HELPER_COLOUR)
    else:
        r.observed = None
        if abstain == "low_light":
            r.sentence = "It's too dark for me to judge the colour."
            r.steps.append(STEP_LIGHT)
        elif abstain == "heavy_cast":
            r.sentence = "The light is too coloured for me to judge the colour."
            r.steps.append(STEP_WHITE_LIGHT)
        elif abstain == "photo_and_name_disagree":
            r.sentence = "I can't judge the colour: the listing photo and the colour name don't agree."
            r.steps.append(STEP_HELPER_COLOUR)
        elif abstain == "in_between":
            r.sentence = (
                f"The colour looks close to {expected}, but not close enough for me to be sure."
                if expected
                else "The colour looks close to the listing photo, but not close enough for me to be sure."
            )
            r.steps.append(STEP_HELPER_COLOUR)
        elif abstain == "nothing_to_compare":
            r.sentence = "The listing doesn't give a colour, so I didn't check it."
        elif abstain == "looks_disagree":
            r.sentence = "The two photos don't agree about the colour, so I can't judge it."
            r.steps.append(STEP_HELPER_COLOUR)
        else:
            r.sentence = "I couldn't check the colour."
            r.steps.append(STEP_HELPER_COLOUR)
    return r


def _size_reason(s: dict[str, Any], listing: dict[str, Any]) -> Reason:
    exp, obs = s.get("expected_spoken"), s.get("observed_spoken")
    finding, conf, why = s.get("finding", "unknown"), s.get("confidence", "not_sure"), s.get("reason")
    applicable = bool(listing.get("size"))
    r = Reason("size", finding, conf, "", expected=exp, observed=obs, applicable=applicable)
    if finding == "disagree":
        if conf == "sure":
            r.sentence = f"The size tag reads {obs}, you ordered {exp}. I'm sure about that."
        elif conf == "fairly_sure":
            r.sentence = f"The size tag seems to read {obs}, you ordered {exp}, but I'm only fairly sure."
            r.steps.append(STEP_TAG)
        else:
            r.sentence = f"The size tag might read {obs}, you ordered {exp}, but I'm not sure."
            r.steps.append(STEP_TAG)
    elif finding == "agree":
        if conf == "sure":
            r.sentence = f"The size tag reads {obs}, as you ordered."
        elif conf == "fairly_sure":
            r.sentence = f"The size tag seems to read {obs}, as you ordered, but I'm only fairly sure."
            r.steps.append(STEP_TAG)
        else:
            r.sentence = f"The size tag might read {obs}, but I'm not sure."
            r.steps.append(STEP_TAG)
    else:
        if why == "no_label_photo":
            r.sentence = "I didn't get a photo of the size tag."
            r.steps.append(STEP_TAG)
        elif why == "reads_disagree":
            a, b = (s.get("candidates") or ["?", "?"])[:2]
            r.sentence = f"I couldn't read the size tag for certain. It could be {a} or {b}."
            r.steps.append(STEP_TAG)
        elif why == "listing_has_no_size":
            r.sentence = (
                f"The size tag reads {obs}. The listing doesn't say a size, so I couldn't compare."
                if obs
                else "The listing doesn't say a size, so I didn't check it."
            )
        elif why == "listing_size_unrecognised":
            r.sentence = (
                f"The size tag reads {obs}, but I couldn't understand the size on the listing."
                if obs
                else "I couldn't understand the size on the listing."
            )
            r.steps.append(STEP_HELPER_SIZE)
        elif why == "looks_disagree":
            r.sentence = "The two photos of the size tag don't agree, so I can't tell the size."
            r.steps.append(STEP_HELPER_SIZE)
        elif why == "different_size_systems":
            r.sentence = f"The size tag reads {obs} and you ordered {exp}. I can't compare those sizes."
            r.steps.append(STEP_HELPER_SIZE)
        else:
            r.sentence = "I couldn't read the size tag."
            r.steps.append(STEP_TAG)
    return r


def _identity_reason(i: dict[str, Any], listing: dict[str, Any], noun: str) -> Reason:
    finding, conf, why = i.get("finding", "unknown"), i.get("confidence", "not_sure"), i.get("reason")
    applicable = why != "nothing_to_compare"
    r = Reason("identity", finding, conf, "", expected=listing.get("title") or None, applicable=applicable)
    mismatches = i.get("mismatches") or []
    if finding == "disagree":
        if i.get("type_differs") and i.get("product_type_item") and i.get("product_type_listing"):
            r.observed = str(i["product_type_item"])
            r.sentence = f"This looks like a {i['product_type_item']}, not a {i['product_type_listing']}."
        elif mismatches:
            m = mismatches[0]
            r.observed = f"{m['name'].replace('_', ' ')}: {m['item']}"
            r.expected = f"{m['name'].replace('_', ' ')}: {m['listing']}"
            r.sentence = f"This doesn't look like the same {noun}: the listing shows {m['listing']}, this one has {m['item']}."
        else:
            r.sentence = f"This might not be the same {noun}"
        if conf == "sure":
            r.sentence += " I'm sure about that."
        else:
            r.sentence = r.sentence.rstrip(".") + ", but I'm only fairly sure."
            r.steps.append(STEP_HELPER_ITEM)
    elif finding == "agree":
        r.observed = noun
        r.sentence = f"It looks like the same {noun}." + ("" if conf == "sure" else " I'm fairly sure.")
    else:
        if why == "model_unavailable":
            r.sentence = f"I couldn't check that it's the same {noun}."
        elif why == "nothing_to_compare":
            r.sentence = "The listing has no photo or name to compare with."
        elif why == "looks_disagree":
            r.sentence = f"The two photos don't agree about whether it's the same {noun}."
        else:
            r.sentence = f"I can't tell from these photos if it's the same {noun}."
        if applicable:
            r.steps.append(STEP_HELPER_ITEM)
    return r


def _damage_reason(d: dict[str, Any]) -> Reason:
    finding, conf, why = d.get("finding", "unknown"), d.get("confidence", "not_sure"), d.get("reason")
    r = Reason("damage", finding, conf, "", expected="no damage")
    found = d.get("found") or []
    if finding == "disagree" and found:
        f = found[0]
        what = KIND_NOUNS.get(f["kind"], "damage")
        where = f" ({f['where']})" if f.get("where") else ""
        r.observed = f"{what.split(' ', 1)[1]}{where}"
        if conf == "sure":
            r.sentence = f"I can see {what}{where}. I'm sure about that."
        else:
            r.sentence = f"There might be {what}{where}, but I'm not sure."
            r.steps.append(STEP_DAMAGE)
    elif finding == "agree":
        r.observed = "no damage"
        r.sentence = "I didn't see any damage."
    else:
        r.sentence = {
            "not_visible": "I couldn't see enough to check for damage.",
            "looks_disagree": "The two photos don't agree about damage.",
        }.get(why or "", "I couldn't check for damage.")
    return r


def _quality_reason(q: dict[str, Any]) -> Reason | None:
    code = q.get("code", "OK")
    if code == "OK":
        return None
    r = Reason(
        "quality",
        "unknown",
        "not_sure",
        QUALITY_SENTENCES.get(code, "The photo isn't clear, so some checks are less certain."),
        observed=code,
    )
    r.steps.append(q.get("guidance") or STEP_HELPER)
    return r


# --------------------------------------------------------------------------------------------
# Verdict
# --------------------------------------------------------------------------------------------


# Two looks before "sure": a "sure" mismatch needs two independent signals that agree. A signal is
# one module reading one view and disagreeing at "fairly sure" or better. The size module's "sure"
# already rests on two reads (the vision model and OCR) of the tag, so it carries two signals; a
# module that saw the difference on two photos (after a retake) carries one per photo. Two modules
# that disagree (colour and identity, say) are two signals too.
MISMATCH_MIN_SIGNALS = 2

STEP_SECOND_LOOK = "One more photo would settle it."

# The one extra shot the app can ask for when the check is not sure. ``prompt`` is spoken as is.
RETAKES: dict[str, dict[str, str]] = {
    "tag": {
        "title": "A close photo of the size tag",
        "prompt": "Hold the size tag flat, about a hand's width from the phone, in good light.",
    },
    "light": {
        "title": "The whole item in better light",
        "prompt": "Take the whole item again, near a window or under a bright light.",
    },
    "paper": {
        "title": "The whole item next to white paper",
        "prompt": "Put a sheet of plain white paper flat next to the item, so both are in the photo.",
    },
}

# What each extra shot re-checks: a tag close-up re-reads the size; a new photo of the whole item in
# better light re-runs colour, identity and damage; a photo next to white paper re-runs colour.
RETAKE_MODULES: dict[str, tuple[str, ...]] = {"tag": ("size",), "light": ("colour", "identity", "damage"), "paper": ("colour",)}


def signals_of(module: str, m: dict[str, Any] | None) -> int:
    """Independent disagreeing signals behind a module's finding (0 when it does not disagree)."""
    if not m or m.get("finding") != "disagree" or CONF_RANK.get(m.get("confidence", "not_sure"), 0) < CONF_RANK["fairly_sure"]:
        return 0
    if "signals" in m:
        return int(m["signals"])
    if module == "size" and m.get("confidence") == "sure":
        return 2  # a sure size needs the model read and the OCR read to agree
    return 1


def _retake_for(module: str, m: dict[str, Any]) -> str | None:
    """Which extra shot would help this module, or None if no photo would."""
    if module == "size":
        why = m.get("reason")
        if why in ("listing_has_no_size", "listing_size_unrecognised", "different_size_systems", "looks_disagree"):
            return None
        return "tag"
    if module == "colour":
        abstain = m.get("abstain_reason")
        if abstain in ("nothing_to_compare", "photo_and_name_disagree", "looks_disagree"):
            return None
        light = m.get("light_reasons") or []
        # Dim or tinted light: a photo in better light. On the SightBench dev split (simulated
        # retakes, colour only) a day-light photo settled colour far more often than white paper
        # under the same tinted light, where the paper itself looks tinted and is rarely taken as
        # a reference. White paper is asked for only when the light was already fine.
        if abstain in ("low_light", "heavy_cast") or any(x in light for x in ("dim", "colour_cast", "heavy_cast")):
            return "light"
        return "paper"
    if module in ("identity", "damage"):
        if m.get("reason") in ("model_unavailable", "nothing_to_compare", "no_item_photo", "error", "looks_disagree", "no_photo"):
            return None
        return "light"
    return None


def choose_retake(
    mods: dict[str, Any], kind: str, demoted: list[str], blocking: list[str], quality: dict[str, Any] | None
) -> dict[str, str] | None:
    """The ONE extra shot most likely to settle a "not sure" check, chosen from why it was not sure.

    A difference seen once comes first (it needs a second look), then any other difference.
    Otherwise the shot that re-checks the most of what kept it from being a match (the modules that
    photo re-runs, see ``RETAKE_MODULES``, plus a poor photo for a new photo of the item), ties going
    to the module listed first in ``MODULE_ORDER``. None after a retake (one extra shot only) or when
    no photo would help (the listing has no colour, say).
    """
    if kind != "unsure" or int(mods.get("looks") or 1) >= 2:
        return None
    differences = [(m, "second_look") for m in MODULE_ORDER if m in demoted]
    differences += [(m, "difference") for m in MODULE_ORDER if m not in demoted and (mods.get(m) or {}).get("finding") == "disagree"]
    for module, why in differences:
        shot = _retake_for(module, mods.get(module) or {})
        if shot:
            return {"kind": shot, "module": module, "why": why, **RETAKES[shot]}
    poor_photo = bool(quality and quality.get("code") in ("TOO_DARK", "BLURRY", "GLARE"))
    options: list[tuple[int, int, str, str]] = []
    for i, module in enumerate(m for m in MODULE_ORDER if m in blocking):
        shot = _retake_for(module, mods.get(module) or {})
        if shot:
            covers = sum(1 for b in blocking if b in RETAKE_MODULES[shot]) + (1 if poor_photo and shot != "tag" else 0)
            options.append((-covers, i, shot, module))
    if options:
        _, _, shot, module = min(options)
        return {"kind": shot, "module": module, "why": "blocks_match", **RETAKES[shot]}
    if poor_photo:
        return {"kind": "light", "module": "quality", "why": "photo", **RETAKES["light"]}
    damage = mods.get("damage") or {}
    if damage.get("reason") == "not_visible":
        return {"kind": "light", "module": "damage", "why": "not_visible", **RETAKES["light"]}
    return None


def _second_look(r: Reason) -> Reason:
    """A "sure" difference seen by one signal only: said as fairly sure, with a second look asked for."""
    r.confidence = "fairly_sure"
    sentence = r.sentence
    if sentence.endswith(" I'm sure about that."):
        sentence = sentence[: -len(" I'm sure about that.")].rstrip(".")
    r.sentence = sentence + ", but I'm only fairly sure from one photo."
    if STEP_SECOND_LOOK not in r.steps:
        r.steps.insert(0, STEP_SECOND_LOOK)
    return r


def _reasons(modules: dict[str, Any], listing: dict[str, Any], noun: str) -> list[Reason]:
    reasons: list[Reason] = []
    if modules.get("size") is not None:
        reasons.append(_size_reason(modules["size"], listing))
    if modules.get("colour") is not None:
        reasons.append(_colour_reason(modules["colour"], listing))
    if modules.get("identity") is not None:
        reasons.append(_identity_reason(modules["identity"], listing, noun))
    if modules.get("damage") is not None:
        reasons.append(_damage_reason(modules["damage"]))
    return reasons


def fuse(modules: dict[str, Any], listing: dict[str, Any], th: dict[str, Any]) -> dict[str, Any]:
    """Combine module outputs into a verdict. ``th`` is ``thresholds()['fusion']``.

    ``modules`` may carry ``looks`` (2 after a retake), and a module may carry ``signals`` (set when
    two photos were combined). ``th["mismatch_min_signals"]`` overrides the two-looks rule (1 gives
    the rule from before it, for re-scoring old runs).
    """
    noun = product_noun(listing, modules.get("identity"))
    reasons = _reasons(modules, listing, noun)
    quality_reason = _quality_reason(modules["quality"]) if modules.get("quality") else None
    if quality_reason is not None:
        reasons.append(quality_reason)

    by_module = {r.module: r for r in reasons}
    mismatch_min = CONF_RANK[th.get("mismatch_min_confidence", "sure")]
    min_signals = int(th.get("mismatch_min_signals", MISMATCH_MIN_SIGNALS))
    sure_disagree = [r for r in reasons if r.finding == "disagree" and CONF_RANK[r.confidence] >= mismatch_min]
    signals = sum(signals_of(m, modules.get(m)) for m in ("size", "colour", "identity", "damage"))
    demoted: list[str] = []
    if sure_disagree and signals < min_signals:
        # One module, one view: not enough for "sure". Say what was seen, ask for a second look.
        demoted = [r.module for r in sure_disagree]
        for r in sure_disagree:
            _second_look(r)
        sure_disagree = []
    any_disagree = any(r.finding == "disagree" for r in reasons)

    required = [m for m in th.get("match_required_modules", []) if m in by_module and by_module[m].applicable]
    min_conf = th.get("match_min_confidence", {})
    blocking = [
        m
        for m in required
        if not (by_module[m].finding == "agree" and CONF_RANK[by_module[m].confidence] >= CONF_RANK[min_conf.get(m, "sure")])
    ]
    if sure_disagree:
        kind = "mismatch"
    elif any_disagree:
        kind = "unsure"
    else:
        kind = "match" if (required and not blocking and quality_reason is None) else "unsure"

    reasons.sort(key=lambda r: (FINDING_ORDER[r.finding], -CONF_RANK[r.confidence], MODULE_ORDER.index(r.module)))
    retake = choose_retake(modules, kind, demoted, blocking, modules.get("quality"))

    if kind == "match":
        parts: list[str] = []
        col, size, ident = by_module.get("colour"), by_module.get("size"), by_module.get("identity")
        if col and col.finding == "agree" and col.expected:
            parts.append(col.expected)
        if size and size.finding == "agree" and size.observed:
            parts.append(f"size {size.observed}")
        if ident and ident.finding == "agree":
            parts.append(f"the same {noun}")
        headline = "This matches: " + ", ".join(parts) + "." if parts else "This matches."
        next_steps: list[str] = []
    elif kind == "mismatch":
        headline = "This doesn't match."
        next_steps = list(STEPS_MISMATCH)
    else:
        headline = "I'm not sure this matches."
        next_steps = []
        if retake:
            # The one shot asked for comes first; the generic photo tips it replaces are dropped.
            next_steps.append(f"One more photo would help: {retake['title'][0].lower()}{retake['title'][1:]}. {retake['prompt']}")
        replaced = {STEP_SECOND_LOOK, STEP_TAG, STEP_LIGHT, STEP_WHITE_LIGHT} if retake else {STEP_SECOND_LOOK}
        for r in reasons:
            for step in r.steps:
                if step not in next_steps and step not in replaced:
                    next_steps.append(step)
        if not any(s.startswith(("Ask a helper", "Or ask a helper")) for s in next_steps):
            next_steps.append(STEP_HELPER)
        elif STEP_HELPER in next_steps:
            next_steps.remove(STEP_HELPER)

    return {
        "kind": kind,
        "reasons": [r.to_dict() for r in reasons],
        "headline": headline,
        "next_steps": next_steps,
        "retake": retake,
        "looks": int(modules.get("looks") or 1),
        "signals": signals,
    }
