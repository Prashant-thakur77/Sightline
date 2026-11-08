"""Regression tests on the demo parcel photos the web app uses (apps/web/public)."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app import main, pipeline
from app.imageio import decode, sanitize
from app.label import OcrLine, extract_size, large_glyph_lines
from app.pipeline import VerifyInputs, run_verify
from app.vlm import NullVlmClient

from fakes import FakeVlm, identity_answer, label_answer

PUBLIC = Path(__file__).resolve().parents[3] / "apps" / "web" / "public"
PARCEL = PUBLIC / "demo-parcel"
STORE = PUBLIC / "demo-store"
NAVY_LISTING = STORE / "harbor-knit-crew--navy.png"
LISTING = {"title": "Harbor knit crew-neck sweater", "colour": "navy", "size": "M", "attributes": {}}

pytestmark = pytest.mark.skipif(not (PARCEL / "wrong-item.jpg").exists(), reason="demo photos not present")


def _run(which: str, vlm, ocr):
    inputs = VerifyInputs(
        item_photos=[sanitize((PARCEL / f"{which}-item.jpg").read_bytes())],
        label_photo=sanitize((PARCEL / f"{which}-tag.jpg").read_bytes()),
        listing_images=[sanitize(NAVY_LISTING.read_bytes())],
        listing=LISTING,
    )
    return run_verify(inputs, vlm=vlm, ocr=ocr)


@pytest.fixture(scope="module")
def wrong(ocr_engine):
    return _run("wrong", NullVlmClient(), ocr_engine)


@pytest.fixture(scope="module")
def right(ocr_engine):
    return _run("right", NullVlmClient(), ocr_engine)


def test_wrong_item_colour_is_dark_and_disagrees(wrong):
    c = wrong["modules"]["colour"]
    assert c["delta_e"] is not None and len(c["listing_images"]) == 1  # the listing photo was used
    assert c["finding"] == "disagree"
    assert c["observed_name"] in ("black", "charcoal", "dark grey")
    assert c["delivered"]["dominant"]["lab"][0] < 40  # never blown up to white
    assert c["delivered"]["white_balance"]["reference_used"] is False  # the bed cover is not paper
    assert c["delivered"]["white_balance"]["exposure_gain"] <= 1.0


def test_wrong_item_mask_does_not_leak_into_the_bed_cover(wrong):
    assert 0.08 < wrong["modules"]["mask"]["item"]["fraction"] < 0.25


def test_wrong_tag_reads_l(wrong):
    s = wrong["modules"]["size"]
    assert s["observed"] == "L"
    assert s["finding"] == "disagree"
    assert s["confidence"] == "fairly_sure"  # one read only without the vision model
    assert wrong["verdict"]["kind"] == "unsure"  # no sure reason without the model


def test_right_item_matches_colour_and_size(right):
    c = right["modules"]["colour"]
    assert c["finding"] == "agree"
    assert c["named_agreement"] is True
    s = right["modules"]["size"]
    assert s["observed"] == "M" and s["finding"] == "agree"
    colour_reason = next(r for r in right["verdict"]["reasons"] if r["module"] == "colour")
    assert colour_reason["sentence"] == "The colour looks navy, as listed."
    assert right["verdict"]["kind"] == "unsure"  # identity cannot be checked without the model


def test_with_the_model_wrong_item_is_a_mismatch(ocr_engine):
    vlm = FakeVlm(label=label_answer("L"), identity=identity_answer("yes"))
    v = _run("wrong", vlm, ocr_engine)["verdict"]
    assert v["kind"] == "mismatch"
    assert v["reasons"][0]["sentence"] == "The size tag reads L, you ordered M. I'm sure about that."


def test_with_the_model_right_item_is_a_match(ocr_engine):
    vlm = FakeVlm(label=label_answer("M"), identity=identity_answer("yes"))
    v = _run("right", vlm, ocr_engine)["verdict"]
    assert v["kind"] == "match"
    assert v["headline"] == "This matches: navy, size M, the same sweater."


def test_glyph_read_ignores_a_junk_box_over_the_whole_tag(ocr_engine):
    rgb = decode((PARCEL / "wrong-tag.jpg").read_bytes(), 1600)
    junk = OcrLine("团", 0.26, (0.06, 0.08, 0.94, 0.87))
    lines = large_glyph_lines(ocr_engine, rgb, [junk])
    size, _ = extract_size(lines)
    assert size is not None and size.canonical == "L"


def test_web_app_multipart_contract(monkeypatch, ocr_engine):
    """Exactly what apps/web/src/server/vision.ts sends: item, label, repeated listing_images, listing."""
    monkeypatch.setattr(pipeline, "get_vlm_client", lambda: NullVlmClient())
    monkeypatch.setattr(pipeline, "get_ocr_engine", lambda: ocr_engine)
    listing_png = NAVY_LISTING.read_bytes()
    files = [
        ("item", ("item.jpg", (PARCEL / "wrong-item.jpg").read_bytes(), "image/jpeg")),
        ("label", ("label.jpg", (PARCEL / "wrong-tag.jpg").read_bytes(), "image/jpeg")),
        ("listing_images", ("harbor-knit-crew--navy.png", listing_png, "application/octet-stream")),
        ("listing_images", ("harbor-knit-crew--navy-2.png", listing_png, "application/octet-stream")),
    ]
    listing = {**LISTING, "attributes": {"colour": "navy", "size": "M"}}
    with TestClient(main.app) as client:
        r = client.post("/verify", files=files, data={"listing": json.dumps(listing)})
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["modules"]["photos"]["listing"]) == 2
    assert len(body["modules"]["colour"]["listing_images"]) == 2
    assert body["modules"]["colour"]["finding"] == "disagree"
    assert body["modules"]["size"]["observed"] == "L"
    assert np.isfinite(body["modules"]["colour"]["delta_e"])
