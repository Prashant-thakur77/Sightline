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
        r.sentence = "I couldn't see enough to check for damage." if why == "not_visible" else "I couldn't check for damage."
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


def fuse(modules: dict[str, Any], listing: dict[str, Any], th: dict[str, Any]) -> dict[str, Any]:
    """Combine module outputs into a verdict. ``th`` is ``thresholds()['fusion']``."""
    noun = product_noun(listing, modules.get("identity"))
    reasons: list[Reason] = []
    if modules.get("size") is not None:
        reasons.append(_size_reason(modules["size"], listing))
    if modules.get("colour") is not None:
        reasons.append(_colour_reason(modules["colour"], listing))
    if modules.get("identity") is not None:
        reasons.append(_identity_reason(modules["identity"], listing, noun))
    if modules.get("damage") is not None:
        reasons.append(_damage_reason(modules["damage"]))
    quality_reason = _quality_reason(modules["quality"]) if modules.get("quality") else None
    if quality_reason is not None:
        reasons.append(quality_reason)

    by_module = {r.module: r for r in reasons}
    mismatch_min = CONF_RANK[th.get("mismatch_min_confidence", "sure")]
    sure_disagree = [r for r in reasons if r.finding == "disagree" and CONF_RANK[r.confidence] >= mismatch_min]
    any_disagree = any(r.finding == "disagree" for r in reasons)

    if sure_disagree:
        kind = "mismatch"
    elif any_disagree:
        kind = "unsure"
    else:
        required = [m for m in th.get("match_required_modules", []) if m in by_module and by_module[m].applicable]
        min_conf = th.get("match_min_confidence", {})
        all_ok = bool(required) and all(
            by_module[m].finding == "agree" and CONF_RANK[by_module[m].confidence] >= CONF_RANK[min_conf.get(m, "sure")] for m in required
        )
        kind = "match" if (all_ok and quality_reason is None) else "unsure"

    reasons.sort(key=lambda r: (FINDING_ORDER[r.finding], -CONF_RANK[r.confidence], MODULE_ORDER.index(r.module)))

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
        for r in reasons:
            for step in r.steps:
                if step not in next_steps:
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
    }
