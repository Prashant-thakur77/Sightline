from __future__ import annotations

import pytest

from app.damage import check_damage
from app.identity import check_identity
from app.vlm import DAMAGE_SCHEMA, IDENTITY_SCHEMA, ImagePart, NullVlmClient

from fakes import FakeVlm, damage_answer, identity_answer

ITEM = [ImagePart(b"item", "image/jpeg")]
LISTED = [ImagePart(b"listing", "image/jpeg")]
LISTING = {"title": "Harbor knit crew-neck sweater", "attributes": {}}


def _schema_keys_present(answer: dict, schema: dict) -> bool:
    return set(schema["required"]) <= set(answer)


def test_fakes_follow_the_output_schemas():
    assert _schema_keys_present(identity_answer("yes"), IDENTITY_SCHEMA)
    assert _schema_keys_present(damage_answer(), DAMAGE_SCHEMA)


def test_same_design_agrees():
    out = check_identity(FakeVlm(identity=identity_answer("yes")), ITEM, LISTED, LISTING)
    assert out["finding"] == "agree"
    assert out["confidence"] == "sure"  # several attributes match


def test_attribute_difference_is_a_sure_disagreement():
    answer = identity_answer("no", mismatch=("neckline", "crew neck", "v-neck"))
    out = check_identity(FakeVlm(identity=answer), ITEM, LISTED, LISTING)
    assert out["finding"] == "disagree"
    assert out["confidence"] == "sure"
    assert out["mismatches"][0]["item"] == "v-neck"


def test_different_product_type_is_a_sure_disagreement():
    answer = identity_answer("no", product_type_item="cardigan")
    answer["attributes"] = []
    out = check_identity(FakeVlm(identity=answer), ITEM, LISTED, LISTING)
    assert out["finding"] == "disagree"
    assert out["confidence"] == "sure"
    assert out["type_differs"] is True


def test_no_without_evidence_is_only_fairly_sure_in_reads_without_citations():
    answer = identity_answer("no", legacy=True)
    out = check_identity(FakeVlm(identity=answer), ITEM, LISTED, LISTING)
    assert out["finding"] == "disagree"
    assert out["confidence"] == "fairly_sure"
    assert out["reason"] == "no_specific_difference"


def test_contradictory_answer_is_unknown():
    answer = identity_answer("yes", mismatch=("pattern", "plain", "striped"))
    out = check_identity(FakeVlm(identity=answer), ITEM, LISTED, LISTING)
    assert out["finding"] == "unknown"
    assert out["reason"] == "contradictory_answer"


def test_unclear_and_unavailable_are_unknown():
    assert check_identity(FakeVlm(identity=identity_answer("unclear")), ITEM, LISTED, LISTING)["finding"] == "unknown"
    out = check_identity(NullVlmClient(), ITEM, LISTED, LISTING)
    assert out["finding"] == "unknown"
    assert out["reason"] == "model_unavailable"


def test_identity_needs_something_to_compare():
    out = check_identity(FakeVlm(), ITEM, [], {"title": None})
    assert out["reason"] == "nothing_to_compare"


def test_identity_tolerates_malformed_answers():
    out = check_identity(FakeVlm(identity={"same_product": "maybe", "attributes": "oops"}), ITEM, LISTED, LISTING)
    assert out["finding"] == "unknown"


def test_no_damage_is_fairly_sure():
    out = check_damage(FakeVlm(damage=damage_answer()), ITEM, dedicated_photo=False)
    assert out["finding"] == "agree"
    assert out["confidence"] == "fairly_sure"


def test_clear_damage_is_sure():
    out = check_damage(FakeVlm(damage=damage_answer(tears=("clearly", "left sleeve cuff"))), ITEM, dedicated_photo=True)
    assert out["finding"] == "disagree"
    assert out["confidence"] == "sure"
    assert out["found"] == [{"kind": "tears", "seen": "clearly", "where": "left sleeve cuff"}]


def test_possible_damage_is_fairly_sure():
    out = check_damage(FakeVlm(damage=damage_answer(stains=("possibly", "collar"))), ITEM, dedicated_photo=False)
    assert out["finding"] == "disagree"
    assert out["confidence"] == "fairly_sure"


@pytest.mark.parametrize("vlm", [NullVlmClient(), FakeVlm(damage=damage_answer(stains=("cannot_tell", "")))])
def test_damage_unknown(vlm):
    assert check_damage(vlm, ITEM, dedicated_photo=False)["finding"] == "unknown"


# ------------------------------------------------------------------------------------------------
# Quote-or-unsure: a read counts only with a visible citation, checked in code.


def test_citation_rules():
    from app.citation import citation_ok

    assert citation_ok("left sleeve cuff", "a brown stain about coin size")
    assert citation_ok("neckline at the top centre", "v-neck")
    assert not citation_ok("", "a brown stain")
    assert not citation_ok("somewhere", "a brown stain")  # no place on the item
    assert not citation_ok("left sleeve", "")
    assert not citation_ok("left sleeve", "not visible")
    assert not citation_ok("neckline", "too dark to see")
    assert not citation_ok("not visible", "a stain")
    assert not citation_ok("collar", "no")


def test_schemas_ask_for_citations():
    attr = IDENTITY_SCHEMA["properties"]["attributes"]["items"]
    assert "item_region" in attr["required"]
    assert "item_type_evidence" in IDENTITY_SCHEMA["required"]
    assert "sees" in DAMAGE_SCHEMA["properties"]["stains"]["required"]


def test_uncited_difference_counts_as_unsure():
    answer = identity_answer("no", mismatch=("neckline", "crew neck", "v-neck"))
    answer["attributes"][-1]["item_region"] = ""
    out = check_identity(FakeVlm(identity=answer), ITEM, LISTED, LISTING)
    assert out["finding"] == "unknown"
    assert out["reason"] == "no_citation"
    assert out["citations"]["uncited_mismatches"] == 1


def test_bare_no_in_a_cited_read_is_unsure():
    out = check_identity(FakeVlm(identity=identity_answer("no")), ITEM, LISTED, LISTING)
    assert out["finding"] == "unknown"
    assert out["reason"] == "no_citation"


def test_type_difference_needs_the_part_that_shows_it():
    answer = identity_answer("no", product_type_item="cardigan")
    answer["attributes"] = []
    answer["item_type_evidence"] = {"region": "", "sees": ""}
    out = check_identity(FakeVlm(identity=answer), ITEM, LISTED, LISTING)
    assert out["finding"] == "unknown"
    answer["item_type_evidence"] = {"region": "front opening", "sees": "a row of buttons down the front"}
    out = check_identity(FakeVlm(identity=answer), ITEM, LISTED, LISTING)
    assert (out["finding"], out["confidence"]) == ("disagree", "sure")


def test_agreement_needs_a_cited_attribute():
    out = check_identity(FakeVlm(identity=identity_answer("yes", cited=False)), ITEM, LISTED, LISTING)
    assert out["finding"] == "unknown"
    assert out["reason"] == "no_citation"


def test_uncited_damage_counts_as_cannot_tell():
    out = check_damage(FakeVlm(damage=damage_answer(stains=("clearly", "front", ""))), ITEM, dedicated_photo=False)
    assert out["finding"] == "unknown"
    assert out["uncited"] == ["stains"]
    assert out["findings"]["stains"]["said"] == "clearly"
    out = check_damage(FakeVlm(damage=damage_answer(tears=("possibly", "", "a small hole"))), ITEM, dedicated_photo=False)
    assert out["finding"] == "unknown"


def test_damage_said_with_a_harmless_explanation_is_not_a_citation():
    hedged = "a darker blotchy area that may be a stain or may just be shadow from the dim light"
    out = check_damage(FakeVlm(damage=damage_answer(stains=("possibly", "centre of chest", hedged))), ITEM, dedicated_photo=False)
    assert out["finding"] == "unknown"
    plain = "a brown stain about the size of a coin"
    out = check_damage(FakeVlm(damage=damage_answer(stains=("possibly", "centre of chest", plain))), ITEM, dedicated_photo=False)
    assert (out["finding"], out["confidence"]) == ("disagree", "fairly_sure")


def test_whole_item_counts_as_a_region_for_the_product_type():
    from app.citation import citation_ok

    assert citation_ok("overall silhouette", "a T-shaped garment with short sleeves")
