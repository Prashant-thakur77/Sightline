from __future__ import annotations

import json

import pytest

from app.config import load_thresholds, threshold_set_names

FITTED = "fitted-dev-2026-11-09"
UNFITTED = "initial-unfitted"


def _flatten(d, prefix=""):
    out = {}
    for k, v in d.items():
        if isinstance(v, dict) and k != "name_tolerance":
            out.update(_flatten(v, f"{prefix}{k}."))
        else:
            out[f"{prefix}{k}"] = v
    return out


def test_the_default_set_is_fitted_on_dev_only():
    th = load_thresholds()
    assert th["version"] == FITTED
    assert th["fitted"]["from"] == UNFITTED
    assert th["fitted"]["on"].startswith("SightBench dev split only")


def test_the_unfitted_set_is_kept_by_name(monkeypatch):
    th = load_thresholds(UNFITTED)
    assert th["version"] == UNFITTED
    assert th["colour"]["poor_bright_luma"] == 0.15
    # The keys added with the fitted set are neutral here, so the old behaviour is reproduced.
    assert th["colour"]["quality_issue_steps"] == 0
    assert th["colour"]["sure_min_de_same_brightness"] is None
    monkeypatch.setenv("VISION_THRESHOLDS", UNFITTED)
    assert load_thresholds()["version"] == UNFITTED
    assert set(threshold_set_names()) >= {FITTED, UNFITTED}


def test_the_fitted_set_changes_exactly_what_it_records():
    fitted = load_thresholds()
    unfitted = load_thresholds(UNFITTED)
    a = _flatten({k: v for k, v in fitted.items() if k not in ("version", "note", "fitted")})
    b = _flatten({k: v for k, v in unfitted.items() if k not in ("version", "note")})
    assert set(a) == set(b)
    changed = {k for k in a if a[k] != b[k]}
    assert changed == set(fitted["fitted"]["changed"])
    assert changed == {"colour.quality_issue_steps", "colour.sure_min_de_same_brightness", "colour.poor_bright_luma"}


def test_an_unknown_set_name_is_refused():
    with pytest.raises(ValueError, match="Unknown threshold set"):
        load_thresholds("fitted-on-test")


def test_an_override_file_overlays_the_default(tmp_path):
    f = tmp_path / "override.json"
    f.write_text(json.dumps({"colour": {"mismatch_min_de": 15.0}}))
    th = load_thresholds(f)
    assert th["version"] == FITTED
    assert th["colour"]["mismatch_min_de"] == 15.0
    assert th["colour"]["poor_bright_luma"] == 0.30
