from __future__ import annotations

import pytest

from app.label import NullOcr, OcrLine, Size, check_size, compare_sizes, extract_size, ocr_size, parse_size
from app.vlm import NullVlmClient

from fakes import FakeOcr, FakeVlm, label_answer
from synth import render_tag


@pytest.mark.parametrize(
    "text,canonical",
    [
        ("M", "M"),
        ("m", "M"),
        ("Medium", "M"),
        ("MED", "M"),
        ("Size: M", "M"),
        ("SIZE M", "M"),
        ("X-Large", "XL"),
        ("extra large", "XL"),
        ("XXL", "XXL"),
        ("2XL", "XXL"),
        ("3XL", "XXXL"),
        ("Small", "S"),
        ("XS", "XS"),
        ("L", "L"),
        ("Lrg", "L"),
        ("One Size", "OS"),
        ("M/38", "M/38"),
        ("M (38)", "M/38"),
        ("M 38", "M/38"),
        ("EU 40", "EU 40"),
        ("40 EU", "EU 40"),
        ("US 8", "US 8"),
        ("UK 10", "UK 10"),
        ("38", "38"),
        ("32/34", "32/34"),
        ("EU 42 / UK 8.5", "EU 42/UK 8.5"),
        ("Taille: L", "L"),
    ],
)
def test_parse_size(text, canonical):
    size = parse_size(text)
    assert size is not None, text
    assert size.canonical == canonical


@pytest.mark.parametrize("text", ["", None, "100% COTTON", "MADE IN INDIA", "S M L XL", "RN 52469", "Machine wash 30"])
def test_parse_size_rejects_non_sizes(text):
    assert parse_size(text) is None


@pytest.mark.parametrize(
    "a,b,verdict",
    [
        ("M", "Medium", "same"),
        ("M", "L", "different"),
        ("M", "M/38", "same"),
        ("38", "M/38", "same"),
        ("EU 40", "40", "same"),
        ("EU 40", "EU 42", "different"),
        ("EU 40", "US 8", "not_comparable"),
        ("M", "38", "not_comparable"),
        ("32/34", "32/34", "same"),
        ("32/34", "32/32", "different"),
    ],
)
def test_compare_sizes(a, b, verdict):
    assert compare_sizes(parse_size(a), parse_size(b)) == verdict


def _line(text, y0, y1, score=0.99):
    return OcrLine(text, score, (0.1, y0, 0.9, y1))


def test_extract_size_prefers_the_size_keyword():
    lines = [_line("HARBOR", 0.05, 0.12), _line("SIZE", 0.2, 0.28), _line("L", 0.3, 0.55), _line("100%COTTON", 0.6, 0.66)]
    size, cands = extract_size(lines)
    assert size.canonical == "L"
    assert cands[0].priority == 2


def test_extract_size_reads_merged_keyword():
    size, _ = extract_size([_line("SIZEM", 0.1, 0.2)])
    assert size.canonical == "M"


def test_extract_size_picks_the_big_letter_on_a_tag():
    lines = [_line("BRANDCO", 0.05, 0.1), _line("XL", 0.2, 0.5), _line("MADEININDIA", 0.6, 0.65), _line("EU 54", 0.7, 0.74)]
    size, _ = extract_size(lines)
    assert size.letter == "XL"


def test_extract_size_refuses_two_different_sizes():
    size, cands = extract_size([_line("M", 0.1, 0.4), _line("L", 0.5, 0.8)])
    assert size is None
    assert {c.size.canonical for c in cands} == {"M", "L"}


@pytest.mark.parametrize("letter", ["S", "M", "L", "XL", "XXL"])
def test_real_ocr_reads_rendered_size_tags(ocr_engine, letter):
    rgb = render_tag(["HARBOR", letter, "100% COTTON"], [34, 150, 26])
    size, _, _ = ocr_size(ocr_engine, rgb)
    assert size is not None
    assert size.canonical == letter


def test_real_ocr_reads_light_text_on_a_dark_woven_tag(ocr_engine):
    rgb = 255 - render_tag(["HARBOR", "L"], [34, 150])
    size, _, _ = ocr_size(ocr_engine, rgb)
    assert size is not None and size.canonical == "L"


def test_real_ocr_reads_size_keyword_tags(ocr_engine):
    rgb = render_tag(["SIZE", "M/38", "MADE IN INDIA"], [36, 110, 24])
    size, _, _ = ocr_size(ocr_engine, rgb)
    assert size.canonical == "M/38"


def test_two_agreeing_reads_are_sure(ocr_engine, th):
    rgb = render_tag(["HARBOR", "M"], [34, 150])
    out = check_size(rgb, "Medium", FakeVlm(label=label_answer("M")), ocr_engine, th["label"])
    assert out["reads_agree"] is True
    assert out["finding"] == "agree"
    assert out["confidence"] == "sure"
    assert out["observed"] == "M"
    assert out["read_a"]["size"] == "M" and out["read_b"]["size"] == "M"


def test_wrong_size_with_agreeing_reads_is_a_sure_disagreement(ocr_engine, th):
    rgb = render_tag(["HARBOR", "L"], [34, 150])
    out = check_size(rgb, "M", FakeVlm(label=label_answer("Large")), ocr_engine, th["label"])
    assert out["finding"] == "disagree"
    assert out["confidence"] == "sure"
    assert out["observed_spoken"] == "L"
    assert out["expected_spoken"] == "M"


def test_disagreeing_reads_are_not_sure(ocr_engine, th):
    rgb = render_tag(["HARBOR", "M"], [34, 150])
    out = check_size(rgb, "M", FakeVlm(label=label_answer("L")), ocr_engine, th["label"])
    assert out["reads_agree"] is False
    assert out["finding"] == "unknown"
    assert out["confidence"] == "not_sure"
    assert out["reason"] == "reads_disagree"
    assert sorted(out["candidates"]) == ["L", "M"]


def test_single_read_is_at_most_fairly_sure(ocr_engine, th):
    rgb = render_tag(["HARBOR", "L"], [34, 150])
    out = check_size(rgb, "M", NullVlmClient(), ocr_engine, th["label"])
    assert out["read_a"]["available"] is False
    assert out["finding"] == "disagree"
    assert out["confidence"] == "fairly_sure"
    assert out["reason"] == "single_read"


def test_vlm_box_is_re_read_by_ocr(ocr_engine, th):
    rgb = render_tag(["HARBOR", "XL", "100% COTTON"], [34, 150, 26])
    vlm = FakeVlm(label=label_answer("XL", box=[0.2, 0.15, 0.8, 0.6]))
    out = check_size(rgb, "XL", vlm, ocr_engine, th["label"])
    assert out["read_b"]["used_crop"] is True
    assert out["confidence"] == "sure"


def test_bad_box_falls_back_to_the_whole_tag(ocr_engine, th):
    rgb = render_tag(["HARBOR", "M"], [34, 150], h=520)
    vlm = FakeVlm(label=label_answer("M", box=[0.05, 0.85, 0.3, 0.95]))  # points at blank fabric
    out = check_size(rgb, "M", vlm, ocr_engine, th["label"])
    assert out["read_b"]["used_crop"] is False
    assert out["read_b"]["size"] == "M"
    assert out["confidence"] == "sure"


def test_low_ocr_score_is_not_sure_alone(th):
    ocr = FakeOcr(lines=[("M", 0.3, (0.3, 0.3, 0.6, 0.6))])
    out = check_size(render_tag(["M"], [150]), "M", NullVlmClient(), ocr, th["label"])
    assert out["finding"] == "agree"
    assert out["confidence"] == "not_sure"


@pytest.mark.parametrize(
    "expected,reason",
    [(None, "listing_has_no_size"), ("Petite Long", "listing_size_unrecognised"), ("EU 40", "different_size_systems")],
)
def test_size_cannot_be_compared(th, expected, reason):
    ocr = FakeOcr(lines=[("M", 0.98, (0.3, 0.3, 0.6, 0.6))])
    out = check_size(render_tag(["M"], [150]), expected, FakeVlm(label=label_answer("M")), ocr, th["label"])
    assert out["finding"] == "unknown"
    assert out["reason"] == reason
    assert out["observed"] == "M"


def test_no_label_photo_or_no_reads(th):
    assert check_size(None, "M", NullVlmClient(), NullOcr(), th["label"])["reason"] == "no_label_photo"
    out = check_size(render_tag(["~"], [150]), "M", NullVlmClient(), NullOcr(), th["label"])
    assert out["reason"] == "unreadable"
    assert out["confidence"] == "not_sure"


def test_size_spoken_form():
    assert Size(letter="M", numeric=((None, "38"),)).spoken == "M"
    assert parse_size("EU 40").spoken == "EU 40"
