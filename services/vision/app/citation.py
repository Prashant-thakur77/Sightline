"""Quote-or-unsure: a model read counts only when it points at something visible.

Identity and damage reads must name a region of the delivered item ("left sleeve cuff",
"neckline at the top") and say what is visible there ("a brown stain about coin size",
"a V-shaped neckline"). The check is done here, in code, on the structured answer; nothing in the
model's wording is trusted to say it looked. A read without such a citation counts as unsure.
"""

from __future__ import annotations

import re

# Words that name a place on a garment, mug or shoe, or a position in the photo.
REGION_WORDS = frozenset(
    [
        "sleeve",
        "sleeves",
        "cuff",
        "cuffs",
        "collar",
        "neck",
        "neckline",
        "neckband",
        "hem",
        "hemline",
        "chest",
        "front",
        "back",
        "body",
        "torso",
        "shoulder",
        "shoulders",
        "waist",
        "waistband",
        "hood",
        "drawstring",
        "drawstrings",
        "pocket",
        "pockets",
        "zip",
        "zipper",
        "placket",
        "button",
        "buttons",
        "seam",
        "seams",
        "yoke",
        "panel",
        "trim",
        "rib",
        "ribbing",
        "band",
        "print",
        "logo",
        "graphic",
        "stripe",
        "stripes",
        "handle",
        "rim",
        "lip",
        "base",
        "bottom",
        "foot",
        "inside",
        "interior",
        "outside",
        "exterior",
        "wall",
        "glaze",
        "toe",
        "toecap",
        "heel",
        "sole",
        "outsole",
        "midsole",
        "upper",
        "tongue",
        "lace",
        "laces",
        "eyelet",
        "eyelets",
        "lining",
        "insole",
        "side",
        "sides",
        "vamp",
        "quarter",
        "counter",
        "strap",
        "left",
        "right",
        "top",
        "centre",
        "center",
        "middle",
        "upper",
        "lower",
        "edge",
        "edges",
        "corner",
        "corners",
        "area",
        "half",
        "whole",
        "overall",
        "silhouette",
        "outline",
    ]
)

# Answers that say nothing was seen. A citation made of these is not a citation.
_HEDGES = re.compile(
    r"\b(not visible|n/?a|unclear|unknown|cannot (see|tell)|can't (see|tell)|can not (see|tell)|hard to (see|tell)|"
    r"too (dark|blurry|small|far)|not (clear|shown|in (the )?(photo|view|frame))|out of (view|frame)|nothing|none)\b",
    re.IGNORECASE,
)

_WORD = re.compile(r"[a-z]+")


def names_region(region: str) -> bool:
    """True when ``region`` names a place on the item (at least one region word, no hedge)."""
    text = (region or "").strip().lower()
    if len(text) < 3 or _HEDGES.search(text):
        return False
    return any(w in REGION_WORDS for w in _WORD.findall(text))


_EMPTY_WORDS = frozenset({"yes", "no", "same", "different", "match", "matches", "mismatch", "ok", "fine", "damage", "damaged"})


def says_what_is_seen(sees: str) -> bool:
    """True when ``sees`` describes something visible: a real word that is not a bare verdict."""
    text = (sees or "").strip().lower()
    if len(text) < 3 or _HEDGES.search(text):
        return False
    return any(len(w) >= 3 and w not in _EMPTY_WORDS for w in _WORD.findall(text))


def citation_ok(region: str | None, sees: str | None) -> bool:
    """A concrete visible citation: a named region and what is visible in it."""
    return names_region(str(region or "")) and says_what_is_seen(str(sees or ""))


# Damage described together with a harmless explanation ("may be a stain or just shadow").
_OTHER_EXPLANATION = re.compile(
    r"\b(or|may|might|could|possibly|perhaps|rather than|likely)\b.{0,80}?\b(shadows?|light(ing)?|glare|reflections?|fold(s|ing)?|creases?|"
    r"wrinkles?|angle|texture|pattern|noise|blur|compression|the photo|background)\b",
    re.IGNORECASE,
)


def damage_citation_ok(where: str | None, sees: str | None) -> bool:
    """A damage citation names the spot and describes damage there, not damage-or-something-else."""
    return citation_ok(where, sees) and not _OTHER_EXPLANATION.search(str(sees or ""))
