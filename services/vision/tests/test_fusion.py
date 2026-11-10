from __future__ import annotations

import json
import re

import pytest

from app.fusion import fuse, product_noun

LISTING = {"title": "Harbor knit crew-neck sweater", "colour": "Navy", "size": "M", "attributes": {}}
OK_QUALITY = {"code": "OK", "guidance": "Hold still, capturing."}


def colour_out(finding="agree", confidence="sure", observed="navy", light="good", reasons=(), abstain=None):
    return {
        "finding": finding,
        "confidence": confidence,
        "observed_name": observed,
        "expected_name": "navy",
        "light_quality": light,
        "light_reasons": list(reasons),
        "abstain_reason": abstain,
        "delta_e": 2.0,
    }


def size_out(finding="agree", confidence="sure", observed="M", reason=None, candidates=None):
    out = {"finding": finding, "confidence": confidence, "expected_spoken": "M", "observed_spoken": observed, "reason": reason}
    if candidates:
        out["candidates"] = candidates
    return out


def identity_out(finding="agree", confidence="sure", reason=None, mismatches=(), type_differs=False, item_type="sweater"):
    return {
        "finding": finding,
        "confidence": confidence,
        "reason": reason,
        "mismatches": list(mismatches),
        "type_differs": type_differs,
        "product_type_listing": "sweater",
        "product_type_item": item_type,
    }


def damage_out(finding="agree", confidence="fairly_sure", found=(), reason=None):
    return {"finding": finding, "confidence": confidence, "found": list(found), "reason": reason}


def modules(**overrides):
    base = {
        "quality": OK_QUALITY,
        "colour": colour_out(),
        "size": size_out(),
        "identity": identity_out(),
        "damage": damage_out(),
    }
    base.update(overrides)
    return base


def run(th, listing=LISTING, **overrides):
    return fuse(modules(**overrides), listing, th["fusion"])


def by_module(verdict):
    return {r["module"]: r for r in verdict["reasons"]}


def test_everything_agrees_is_a_match(th):
    v = run(th)
    assert v["kind"] == "match"
    assert v["headline"] == "This matches: navy, size M, the same sweater."
    assert v["next_steps"] == []


def test_verdict_has_the_shared_shape(th):
    v = run(th, size=size_out("disagree", observed="L"))
    assert set(v) == {"kind", "reasons", "headline", "next_steps", "retake", "looks", "signals"}
    for r in v["reasons"]:
        assert set(r) <= {"module", "finding", "confidence", "expected", "observed", "sentence"}
        assert r["module"] in ("colour", "size", "identity", "damage", "quality")
        assert r["finding"] in ("agree", "disagree", "unknown")
        assert r["confidence"] in ("sure", "fairly_sure", "not_sure")
        assert all(v is not None for v in r.values())
    json.dumps(v)


def test_spoken_example_wrong_size_and_dim_colour(th):
    v = run(
        th,
        size=size_out("disagree", "sure", observed="L"),
        colour=colour_out("disagree", "fairly_sure", observed="black", light="dim", reasons=["dim"]),
    )
    assert v["kind"] == "mismatch"
    assert v["headline"] == "This doesn't match."
    assert v["reasons"][0]["sentence"] == "The size tag reads L, you ordered M. I'm sure about that."
    assert v["reasons"][1]["sentence"] == "The colour looks black, not navy, but the light is dim so I'm less sure."
    assert v["reasons"][0]["expected"] == "M" and v["reasons"][0]["observed"] == "L"
    assert v["next_steps"]


def test_a_mismatch_needs_a_sure_reason(th):
    v = run(th, colour=colour_out("disagree", "fairly_sure", observed="black", light="dim", reasons=["dim"]))
    assert v["kind"] == "unsure"
    assert v["retake"]["kind"] == "light"
    assert v["next_steps"][0] == (
        "One more photo would help: the whole item in better light. Take the whole item again, near a window or under a bright light."
    )


def test_one_sure_signal_is_not_enough_for_a_mismatch(th):
    v = run(th, colour=colour_out("disagree", "sure", observed="black"))
    assert v["kind"] == "unsure"
    reason = by_module(v)["colour"]
    assert reason["confidence"] == "fairly_sure"
    assert reason["sentence"] == "The colour looks black, not navy, but I'm only fairly sure from one photo."
    assert v["retake"] == {
        "kind": "paper",
        "module": "colour",
        "why": "second_look",
        "title": "The whole item next to white paper",
        "prompt": "Put a sheet of plain white paper flat next to the item, so both are in the photo.",
    }
    assert v["signals"] == 1


def test_two_modules_that_disagree_make_a_sure_mismatch(th):
    m = {"name": "neckline", "listing": "a crew neck", "item": "a v-neck", "match": "no"}
    v = run(th, colour=colour_out("disagree", "sure", observed="black"), identity=identity_out("disagree", "fairly_sure", mismatches=[m]))
    assert v["kind"] == "mismatch"
    assert v["retake"] is None
    assert by_module(v)["colour"]["sentence"] == "The colour looks black, not navy. I'm sure about that."


def test_the_same_module_on_two_photos_makes_a_sure_mismatch(th):
    colour = {**colour_out("disagree", "sure", observed="black"), "signals": 2}
    v = run(th, colour=colour, looks=2)
    assert v["kind"] == "mismatch"
    assert v["looks"] == 2


def test_a_sure_size_rests_on_two_reads(th):
    v = run(th, size=size_out("disagree", "sure", observed="L"))
    assert v["kind"] == "mismatch"
    assert v["signals"] == 2


def test_the_old_rule_can_be_replayed(th):
    v = fuse(modules(colour=colour_out("disagree", "sure", observed="black")), LISTING, {**th["fusion"], "mismatch_min_signals": 1})
    assert v["kind"] == "mismatch"


def test_no_second_retake_after_a_retake(th):
    v = run(th, colour=colour_out("disagree", "sure", observed="black"), looks=2)
    assert v["kind"] == "unsure"
    assert v["retake"] is None


def test_low_light_colour_abstains_and_blocks_a_match(th):
    v = run(th, colour=colour_out("unknown", "not_sure", light="poor", reasons=["too_dark"], abstain="low_light"))
    assert v["kind"] == "unsure"
    reason = by_module(v)["colour"]
    assert reason["sentence"] == "It's too dark for me to judge the colour."
    assert "observed" not in reason
    assert v["retake"]["kind"] == "light"
    assert v["next_steps"][0].startswith("One more photo would help: the whole item in better light.")


def test_tinted_light_asks_for_better_light_and_good_light_for_white_paper(th):
    v = run(th, colour=colour_out("unknown", "not_sure", reasons=["heavy_cast"], abstain="heavy_cast"))
    assert v["retake"]["kind"] == "light"
    v = run(th, colour=colour_out("unknown", "not_sure", abstain="in_between"))
    assert v["retake"]["kind"] == "paper"


def test_size_reads_disagree_is_unsure(th):
    v = run(th, size=size_out("unknown", "not_sure", observed=None, reason="reads_disagree", candidates=["L", "M"]))
    assert v["kind"] == "unsure"
    assert by_module(v)["size"]["sentence"] == "I couldn't read the size tag for certain. It could be L or M."
    assert v["retake"]["kind"] == "tag"
    assert v["next_steps"][0] == (
        "One more photo would help: a close photo of the size tag. Hold the size tag flat, about a hand's width from the phone, in good light."
    )


def test_the_shot_that_rechecks_the_most_is_asked_for(th):
    # Size, colour (dim) and identity all keep it from a match: a photo in better light re-checks two of them.
    v = run(
        th,
        size=size_out("agree", "fairly_sure"),
        colour=colour_out("unknown", "not_sure", reasons=["dim"], abstain="low_light"),
        identity=identity_out("unknown", "not_sure", reason="unclear"),
    )
    assert v["retake"]["kind"] == "light"
    # Only the size is in the way: a tag close-up.
    v = run(th, size=size_out("agree", "fairly_sure"))
    assert v["retake"]["kind"] == "tag"


def test_a_difference_comes_before_what_blocks_a_match(th):
    v = run(
        th,
        size=size_out("unknown", "not_sure", observed=None, reason="unreadable"),
        identity=identity_out("disagree", "sure", type_differs=True, item_type="cardigan"),
    )
    assert v["retake"]["module"] == "identity"
    assert v["retake"]["kind"] == "light"


def test_single_read_size_cannot_make_a_match(th):
    v = run(th, size=size_out("agree", "fairly_sure"))
    assert v["kind"] == "unsure"


def test_identity_unavailable_blocks_a_match(th):
    v = run(th, identity=identity_out("unknown", "not_sure", reason="model_unavailable"))
    assert v["kind"] == "unsure"
    assert by_module(v)["identity"]["sentence"] == "I couldn't check that it's the same sweater."
    assert "Ask a helper to check that it's the same item." in v["next_steps"]


def test_identity_attribute_mismatch_sentence(th):
    m = {"name": "neckline", "listing": "a crew neck", "item": "a v-neck", "match": "no"}
    v = run(th, identity=identity_out("disagree", "sure", mismatches=[m]))
    assert v["kind"] == "unsure"
    assert by_module(v)["identity"]["sentence"] == (
        "This doesn't look like the same sweater: the listing shows a crew neck, this one has a v-neck, but I'm only fairly sure from one photo."
    )
    v = run(th, identity={**identity_out("disagree", "sure", mismatches=[m]), "signals": 2}, looks=2)
    assert v["kind"] == "mismatch"
    assert by_module(v)["identity"]["sentence"].endswith("this one has a v-neck. I'm sure about that.")


def test_identity_product_type_sentence(th):
    v = run(th, identity=identity_out("disagree", "sure", type_differs=True, item_type="cardigan"))
    assert by_module(v)["identity"]["sentence"] == "This looks like a cardigan, not a sweater, but I'm only fairly sure from one photo."


def test_clear_damage_needs_two_looks_and_possible_damage_is_unsure(th):
    tear = {"kind": "tears", "seen": "clearly", "where": "left sleeve cuff"}
    v = run(th, damage=damage_out("disagree", "sure", found=[tear]))
    assert v["kind"] == "unsure"
    assert by_module(v)["damage"]["sentence"] == "I can see a tear (left sleeve cuff), but I'm only fairly sure from one photo."
    assert v["retake"]["kind"] == "light"
    v = run(th, damage={**damage_out("disagree", "sure", found=[tear]), "signals": 2}, looks=2)
    assert v["kind"] == "mismatch"
    assert by_module(v)["damage"]["sentence"] == "I can see a tear (left sleeve cuff). I'm sure about that."
    stain = {"kind": "stains", "seen": "possibly", "where": "collar"}
    v = run(th, damage=damage_out("disagree", "fairly_sure", found=[stain]))
    assert v["kind"] == "unsure"
    assert "Take a close photo of the spot that might be damaged." in v["next_steps"]


def test_unknown_damage_does_not_block_a_match(th):
    v = run(th, damage=damage_out("unknown", "not_sure", reason="model_unavailable"))
    assert v["kind"] == "match"


def test_a_poor_photo_blocks_a_match_but_not_a_mismatch(th):
    blurry = {"code": "BLURRY", "guidance": "Hold still for a moment."}
    v = run(th, quality=blurry)
    assert v["kind"] == "unsure"
    assert by_module(v)["quality"]["sentence"] == "The photo is a little blurry, so some checks are less certain."
    assert "Hold still for a moment." in v["next_steps"]
    v = run(th, quality=blurry, size=size_out("disagree", "sure", observed="L"))
    assert v["kind"] == "mismatch"


def test_modules_that_do_not_apply_are_skipped(th):
    listing = {"title": "Harbor knit crew-neck sweater", "colour": "Navy", "size": None}
    v = run(th, listing=listing, size=size_out("unknown", "not_sure", observed="M", reason="listing_has_no_size"))
    assert v["kind"] == "match"
    assert v["headline"] == "This matches: navy, the same sweater."


def test_unsure_always_offers_a_helper(th):
    v = run(th, size=size_out("unknown", "not_sure", observed=None, reason="unreadable"))
    assert v["kind"] == "unsure"
    assert v["headline"] == "I'm not sure this matches."
    assert any("helper" in s for s in v["next_steps"])


@pytest.mark.parametrize(
    "overrides",
    [
        {},
        {"size": size_out("disagree", "sure", observed="L")},
        {"colour": colour_out("disagree", "fairly_sure", observed="black", light="dim", reasons=["dim"])},
        {"colour": colour_out("unknown", "not_sure", abstain="heavy_cast", reasons=["heavy_cast"])},
        {"identity": identity_out("unknown", "not_sure", reason="unclear")},
    ],
)
def test_sentences_use_words_not_numbers(th, overrides):
    v = run(th, **overrides)
    for text in [v["headline"], *v["next_steps"], *(r["sentence"] for r in v["reasons"])]:
        assert "%" not in text
        assert not re.search(r"\d+\.\d", text)
        assert "percent" not in text.lower()


def test_product_noun():
    assert product_noun({"title": "Harbor knit crew-neck sweater"}) == "sweater"
    assert product_noun({"title": "Mug", "attributes": {"type": "Coffee mug"}}) == "coffee mug"
    assert product_noun({}) == "item"


@pytest.mark.parametrize("module", ["colour", "size", "identity"])
def test_a_failed_module_blocks_a_match(th, module):
    failed = {"finding": "unknown", "confidence": "not_sure", "reason": "error", "error": "RuntimeError"}
    v = run(th, **{module: failed})
    assert v["kind"] == "unsure"
