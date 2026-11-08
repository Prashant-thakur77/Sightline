from __future__ import annotations

import json

import numpy as np
import pytest

from app import colour_names
from app.colour import ciede2000
from app.config import load_thresholds

REQUIRED = [
    "black",
    "white",
    "grey",
    "red",
    "blue",
    "green",
    "navy",
    "charcoal",
    "burgundy",
    "olive",
    "cream",
    "taupe",
    "teal",
    "khaki",
    "maroon",
    "ivory",
    "beige",
    "mustard",
    "forest green",
    "royal blue",
    "heather grey",
]


def test_table_is_curated_and_large_enough():
    names = [e.name for e in colour_names.TABLE]
    assert len(names) >= 60
    assert len(set(names)) == len(names)
    for name in REQUIRED:
        assert name in names


def test_lab_centres_are_valid_and_distinct():
    labs = np.stack([e.lab for e in colour_names.TABLE])
    assert np.isfinite(labs).all()
    assert (labs[:, 0] >= 0).all() and (labs[:, 0] <= 100).all()
    for i, e in enumerate(colour_names.TABLE):
        others = np.delete(labs, i, axis=0)
        assert ciede2000(np.broadcast_to(e.lab, others.shape), others).min() > 1.0, e.name


@pytest.mark.parametrize(
    "text,name",
    [
        ("Navy", "navy"),
        ("NAVY BLUE", "navy"),
        ("heather gray", "heather grey"),
        ("Colour: Charcoal Grey", "charcoal"),
        ("Forest-Green", "forest green"),
        ("midnight navy", "navy"),
        ("navy/white stripe", "navy"),
        ("Off-White", "off white"),
        ("Gray", "grey"),
        ("Royal Blue", "royal blue"),
        ("deep burgundy", "burgundy"),
        ("navy stripe", "navy"),
    ],
)
def test_lookup_normalises_listing_names(text, name):
    entry = colour_names.lookup(text)
    assert entry is not None
    assert entry.name == name


@pytest.mark.parametrize("text", [None, "", "Sunset Dream", "multi"])
def test_lookup_returns_none_for_unknown_names(text):
    assert colour_names.lookup(text) is None


def test_nearest_name_round_trips_table_entries():
    for entry in colour_names.TABLE:
        assert colour_names.nearest(entry.lab).name == entry.name


def test_tolerances_come_from_thresholds_and_can_be_overridden(tmp_path):
    base = load_thresholds()["colour"]
    assert colour_names.tolerance("navy", base) == base["name_tolerance"]["navy"]
    assert colour_names.tolerance("teal", base) == base["name_tolerance_default"]
    override = tmp_path / "override.json"
    override.write_text(json.dumps({"colour": {"name_tolerance": {"teal": 3.5}}}))
    th = load_thresholds(override)["colour"]
    assert colour_names.tolerance("teal", th) == 3.5
    assert colour_names.tolerance("navy", th) == base["name_tolerance"]["navy"]  # merged, not replaced
