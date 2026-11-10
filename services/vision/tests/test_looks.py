"""Second look: one extra photo, combined with the first check (two looks before "sure")."""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient
from test_fusion import LISTING, colour_out, damage_out, identity_out, modules, size_out

from app import main, pipeline
from app.fusion import fuse
from app.looks import combine_looks, combine_module

from fakes import FakeVlm, damage_answer, label_answer
from synth import BLACK, NAVY, listing_image, render_scene, render_tag, to_jpeg, to_png


def test_two_disagreeing_looks_count_twice():
    a = colour_out("disagree", "sure", observed="black")
    b = colour_out("disagree", "fairly_sure", observed="black", light="dim", reasons=["dim"])
    out = combine_module("colour", a, b)
    assert out["finding"] == "disagree"
    assert out["confidence"] == "sure"
    assert out["signals"] == 2
    assert [x["finding"] for x in out["looks"]] == ["disagree", "disagree"]


def test_looks_that_contradict_are_unknown():
    out = combine_module("colour", colour_out("disagree", "sure", observed="black"), colour_out("agree", "sure"))
    assert out["finding"] == "unknown"
    assert out["abstain_reason"] == "looks_disagree"
    out = combine_module("size", size_out("disagree", "fairly_sure", observed="L"), size_out("agree", "sure"))
    assert out["reason"] == "looks_disagree"


def test_two_tag_looks_must_read_the_same_size():
    a = {**size_out("disagree", "fairly_sure", observed="L"), "observed": "L"}
    b = {**size_out("disagree", "fairly_sure", observed="XL"), "observed": "XL"}
    assert combine_module("size", a, b)["finding"] == "unknown"
    b = {**size_out("disagree", "fairly_sure", observed="L"), "observed": "L"}
    assert combine_module("size", a, b)["signals"] == 2


def test_a_retake_settles_what_the_first_photo_could_not():
    first = modules(colour=colour_out("unknown", "not_sure", abstain="heavy_cast", reasons=["heavy_cast"]))
    second = {"colour": colour_out("agree", "fairly_sure"), "quality": {"code": "OK", "guidance": ""}}
    combined = combine_looks(first, second, "paper")
    assert combined["colour"]["finding"] == "agree"
    assert combined["looks"] == 2


def test_one_disagreement_seen_twice_becomes_a_sure_mismatch(th):
    first = modules(colour=colour_out("disagree", "sure", observed="black"))
    v1 = fuse(first, LISTING, th["fusion"])
    assert v1["kind"] == "unsure"
    assert v1["retake"]["kind"] == "paper"
    combined = combine_looks(first, {"colour": colour_out("disagree", "sure", observed="black")}, "paper")
    v2 = fuse(combined, LISTING, th["fusion"])
    assert v2["kind"] == "mismatch"
    assert v2["looks"] == 2
    assert v2["retake"] is None


def test_a_difference_seen_once_stays_not_sure_after_a_retake(th):
    m = {"name": "neckline", "listing": "a crew neck", "item": "a v-neck", "match": "no"}
    first = modules(identity=identity_out("disagree", "sure", mismatches=[m]))
    combined = combine_looks(first, {"identity": identity_out("unknown", "not_sure", reason="unclear"), "damage": damage_out()}, "light")
    v = fuse(combined, LISTING, th["fusion"])
    assert v["kind"] == "unsure"
    assert v["retake"] is None


def test_a_tag_retake_only_replaces_the_size():
    first = modules(size=size_out("unknown", "not_sure", reason="reads_disagree", candidates=["L", "M"]))
    combined = combine_looks(first, {"size": size_out("agree", "sure")}, "tag")
    assert combined["size"]["finding"] == "agree"
    assert combined["colour"] == first["colour"]


def test_unknown_retake_kind_is_refused():
    with pytest.raises(ValueError):
        combine_looks(modules(), {}, "flash")


# ------------------------------------------------------------------------------------------------
# The pipeline and the API


@pytest.fixture(scope="module")
def client():
    with TestClient(main.app) as c:
        yield c


@pytest.fixture
def fake_engines(monkeypatch, ocr_engine):
    vlm = FakeVlm()
    monkeypatch.setattr(pipeline, "get_vlm_client", lambda: vlm)
    monkeypatch.setattr(pipeline, "get_ocr_engine", lambda: ocr_engine)
    return vlm


@pytest.fixture(scope="module")
def photos():
    return {
        "navy": to_jpeg(render_scene(NAVY)[0]),
        "black": to_jpeg(render_scene(BLACK)[0]),
        "tag_m": to_png(render_tag(["HARBOR", "M", "100% COTTON"], [34, 150, 26])),
        "listing": to_jpeg(listing_image(NAVY)),
    }


LISTING_SWEATER = {"title": "Harbor knit crew-neck sweater", "colour": "Navy", "size": "M", "attributes": {"type": "sweater"}}


def test_recheck_combines_the_first_check_with_one_photo(client, fake_engines, photos):
    fake_engines.damage = damage_answer(tears=("clearly", "left sleeve"))
    files = [
        ("item", ("item.jpg", photos["navy"], "image/jpeg")),
        ("label", ("tag.png", photos["tag_m"], "image/png")),
        ("listing_image", ("l.jpg", photos["listing"], "image/jpeg")),
    ]
    first = client.post("/verify", files=files, data={"listing": json.dumps(LISTING_SWEATER)}).json()
    assert first["verdict"]["kind"] == "unsure"  # a tear seen once
    assert first["verdict"]["retake"]["kind"] == "light"
    calls_before = list(fake_engines.calls)

    r = client.post(
        "/recheck",
        files=[("retake", ("r.jpg", photos["navy"], "image/jpeg")), ("listing_images", ("l.jpg", photos["listing"], "image/jpeg"))],
        data={"retake_kind": "light", "previous": json.dumps(first["modules"]), "listing": json.dumps(LISTING_SWEATER)},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["verdict"]["kind"] == "mismatch"  # the tear seen on both photos
    assert body["verdict"]["looks"] == 2
    assert body["verdict"]["retake"] is None
    assert body["modules"]["second_look"]["kind"] == "light"
    new_calls = fake_engines.calls[len(calls_before) :]
    assert sorted(c[0] for c in new_calls) == ["damage", "identity"]  # no new size read


def test_recheck_with_a_tag_photo_reads_the_size_only(client, fake_engines, photos):
    fake_engines.label = label_answer("M")
    previous = modules(size=size_out("unknown", "not_sure", reason="no_label_photo"))
    r = client.post(
        "/recheck",
        files=[("retake", ("t.png", photos["tag_m"], "image/png"))],
        data={"retake_kind": "tag", "previous": json.dumps(previous), "listing": json.dumps(LISTING_SWEATER)},
    )
    assert r.status_code == 200, r.text
    assert [c[0] for c in fake_engines.calls] == ["label"]
    assert r.json()["modules"]["size"]["looks"][1]["finding"] in ("agree", "unknown")


@pytest.mark.parametrize(
    ("data", "code"),
    [
        ({"retake_kind": "light", "previous": "not json"}, "bad_previous"),
        ({"retake_kind": "light", "previous": json.dumps({"looks": 2, "colour": {}})}, "already_rechecked"),
    ],
)
def test_recheck_refuses_bad_requests(client, fake_engines, photos, data, code):
    r = client.post(
        "/recheck",
        files=[("retake", ("r.jpg", photos["navy"], "image/jpeg"))],
        data={**data, "listing": json.dumps(LISTING_SWEATER)},
    )
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == code


def test_recheck_refuses_an_unknown_kind(client, fake_engines, photos):
    r = client.post(
        "/recheck",
        files=[("retake", ("r.jpg", photos["navy"], "image/jpeg"))],
        data={"retake_kind": "flash", "previous": json.dumps(modules()), "listing": json.dumps(LISTING_SWEATER)},
    )
    assert r.status_code == 422
