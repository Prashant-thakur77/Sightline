from __future__ import annotations

import numpy as np
import pytest

from app import colour
from app.mask import item_mask

from synth import BLACK, NAVY, RED, add_paper, colour_cast, dim, listing_image, render_scene

# The 34 published CIEDE2000 reference test pairs: (Lab 1, Lab 2, expected delta E to 4 decimals).
REFERENCE_PAIRS = [
    ((50.0000, 2.6772, -79.7751), (50.0000, 0.0000, -82.7485), 2.0425),
    ((50.0000, 3.1571, -77.2803), (50.0000, 0.0000, -82.7485), 2.8615),
    ((50.0000, 2.8361, -74.0200), (50.0000, 0.0000, -82.7485), 3.4412),
    ((50.0000, -1.3802, -84.2814), (50.0000, 0.0000, -82.7485), 1.0000),
    ((50.0000, -1.1848, -84.8006), (50.0000, 0.0000, -82.7485), 1.0000),
    ((50.0000, -0.9009, -85.5211), (50.0000, 0.0000, -82.7485), 1.0000),
    ((50.0000, 0.0000, 0.0000), (50.0000, -1.0000, 2.0000), 2.3669),
    ((50.0000, -1.0000, 2.0000), (50.0000, 0.0000, 0.0000), 2.3669),
    ((50.0000, 2.4900, -0.0010), (50.0000, -2.4900, 0.0009), 7.1792),
    ((50.0000, 2.4900, -0.0010), (50.0000, -2.4900, 0.0010), 7.1792),
    ((50.0000, 2.4900, -0.0010), (50.0000, -2.4900, 0.0011), 7.2195),
    ((50.0000, 2.4900, -0.0010), (50.0000, -2.4900, 0.0012), 7.2195),
    ((50.0000, -0.0010, 2.4900), (50.0000, 0.0009, -2.4900), 4.8045),
    ((50.0000, -0.0010, 2.4900), (50.0000, 0.0010, -2.4900), 4.8045),
    ((50.0000, -0.0010, 2.4900), (50.0000, 0.0011, -2.4900), 4.7461),
    ((50.0000, 2.5000, 0.0000), (50.0000, 0.0000, -2.5000), 4.3065),
    ((50.0000, 2.5000, 0.0000), (73.0000, 25.0000, -18.0000), 27.1492),
    ((50.0000, 2.5000, 0.0000), (61.0000, -5.0000, 29.0000), 22.8977),
    ((50.0000, 2.5000, 0.0000), (56.0000, -27.0000, -3.0000), 31.9030),
    ((50.0000, 2.5000, 0.0000), (58.0000, 24.0000, 15.0000), 19.4535),
    ((50.0000, 2.5000, 0.0000), (50.0000, 3.1736, 0.5854), 1.0000),
    ((50.0000, 2.5000, 0.0000), (50.0000, 3.2972, 0.0000), 1.0000),
    ((50.0000, 2.5000, 0.0000), (50.0000, 1.8634, 0.5757), 1.0000),
    ((50.0000, 2.5000, 0.0000), (50.0000, 3.2592, 0.3350), 1.0000),
    ((60.2574, -34.0099, 36.2677), (60.4626, -34.1751, 39.4387), 1.2644),
    ((63.0109, -31.0961, -5.8663), (62.8187, -29.7946, -4.0864), 1.2630),
    ((61.2901, 3.7196, -5.3901), (61.4292, 2.2480, -4.9620), 1.8731),
    ((35.0831, -44.1164, 3.7933), (35.0232, -40.0716, 1.5901), 1.8645),
    ((22.7233, 20.0904, -46.6940), (23.0331, 14.9730, -42.5619), 2.0373),
    ((36.4612, 47.8580, 18.3852), (36.2715, 50.5065, 21.2231), 1.4146),
    ((90.8027, -2.0831, 1.4410), (91.1528, -1.6435, 0.0447), 1.4441),
    ((90.9257, -0.5406, -0.9208), (88.6381, -0.8985, -0.7239), 1.5381),
    ((6.7747, -0.2908, -2.4247), (5.8714, -0.0985, -2.2286), 0.6377),
    ((2.0776, 0.0795, -1.1350), (0.9033, -0.0636, -0.5514), 0.9082),
]


@pytest.mark.parametrize("lab1,lab2,expected", REFERENCE_PAIRS)
def test_ciede2000_matches_published_reference_pairs(lab1, lab2, expected):
    assert round(colour.ciede2000(lab1, lab2), 4) == expected


def test_ciede2000_is_vectorised_and_symmetric():
    a = np.array([p[0] for p in REFERENCE_PAIRS])
    b = np.array([p[1] for p in REFERENCE_PAIRS])
    expected = np.array([p[2] for p in REFERENCE_PAIRS])
    np.testing.assert_allclose(colour.ciede2000(a, b), expected, atol=5e-5)
    np.testing.assert_allclose(colour.ciede2000(b, a), expected, atol=5e-5)
    assert colour.ciede2000((40.0, 10.0, -5.0), (40.0, 10.0, -5.0)) == 0.0


def test_lightness_weight_kL_reduces_lightness_only_differences():
    a, b = (30.0, 0.0, 0.0), (50.0, 0.0, 0.0)
    assert colour.ciede2000(a, b, kL=2.0) == pytest.approx(colour.ciede2000(a, b) / 2.0, rel=1e-9)


@pytest.mark.parametrize(
    "rgb,lab",
    [
        ((255, 255, 255), (100.0, 0.0, 0.0)),
        ((0, 0, 0), (0.0, 0.0, 0.0)),
        ((255, 0, 0), (53.2408, 80.0925, 67.2032)),
        ((0, 0, 255), (32.2970, 79.1875, -107.8602)),
        ((128, 128, 128), (53.5850, 0.0, 0.0)),
    ],
)
def test_srgb_to_lab_known_values(rgb, lab):
    got = colour.srgb_to_lab(np.array(rgb, dtype=np.uint8))
    np.testing.assert_allclose(got, lab, atol=0.01)


def test_lab_round_trip():
    rng = np.random.default_rng(0)
    rgb = rng.integers(0, 256, (200, 3)).astype(np.uint8)
    back = colour.lab_to_srgb(colour.srgb_to_lab(rgb)) * 255.0
    np.testing.assert_allclose(back, rgb, atol=0.01)


def test_kmeans_is_deterministic_and_finds_blobs():
    rng = np.random.default_rng(1)
    centres = np.array([[20.0, 5.0, -25.0], [60.0, -10.0, 10.0], [90.0, 0.0, 0.0]])
    pts = np.concatenate([c + rng.normal(0, 1.0, (300, 3)) for c in centres])
    c1, l1 = colour.kmeans(pts, k=3, seed=0)
    c2, l2 = colour.kmeans(pts, k=3, seed=0)
    np.testing.assert_array_equal(c1, c2)
    np.testing.assert_array_equal(l1, l2)
    found = sorted(map(tuple, np.round(c1)))
    for expected in centres:
        assert min(np.linalg.norm(np.array(f) - expected) for f in found) < 1.0


def test_dominant_colour_is_the_largest_cluster(th):
    rng = np.random.default_rng(2)
    big = np.array([20.0, 5.0, -25.0]) + rng.normal(0, 1, (700, 3))
    small = np.array([80.0, 0.0, 0.0]) + rng.normal(0, 1, (300, 3))
    dom = colour.dominant_colour(np.concatenate([big, small]), th["colour"])
    assert colour.ciede2000(dom.lab, (20.0, 5.0, -25.0)) < 1.0
    assert dom.fraction == pytest.approx(0.7, abs=0.02)


def _analyse(rgb, th):
    m = item_mask(rgb, th["mask"])
    return colour.analyse_image(rgb, m.mask, th["colour"]), m


@pytest.fixture(scope="module")
def navy_listing(th):
    rgb = listing_image(NAVY)
    return _analyse(rgb, th)[0]


def test_white_paper_next_to_the_item_is_used_as_reference(th):
    rgb, _ = render_scene(NAVY, bg=(150, 142, 130))
    ic, _ = _analyse(add_paper(rgb), th)
    assert ic.white_balance.reference_used is True
    assert ic.white_balance.method == "white_reference"
    assert th["colour"]["exposure_gain_min"] <= ic.white_balance.exposure_gain <= th["colour"]["exposure_gain_max"]


@pytest.mark.parametrize("bg", [(185, 178, 166), (228, 224, 216)])
def test_a_plain_surface_filling_the_background_is_not_a_white_reference(th, bg):
    # A beige bed cover or a light table is the whole background, not a sheet of paper. Treating it
    # as white once blew a black sweater up to "white".
    rgb, _ = render_scene(BLACK, bg=bg)
    ic, _ = _analyse(rgb, th)
    assert ic.white_balance.reference_used is False
    assert ic.white_balance.exposure_gain == 1.0
    assert ic.dominant.lab[0] < 25


def test_exposure_gain_never_clips_the_item(th):
    rgb, _ = render_scene((200, 200, 205), bg=(120, 112, 100))  # a pale item on a dark table
    rgb = add_paper(rgb, colour=(170, 170, 167))  # a dim sheet of paper asks for a large gain
    ic, m = _analyse(rgb, th)
    lin = colour.srgb_to_linear(rgb[m.mask]) * np.asarray(ic.white_balance.gains) * ic.white_balance.exposure_gain
    assert np.percentile(lin.max(axis=-1), 99) <= 0.99


def test_background_leaking_into_the_mask_is_ignored(th):
    rgb, truth = render_scene(BLACK, bg=(185, 178, 166))
    leaky = truth.copy()
    leaky[:, : rgb.shape[1] // 3] = True  # a third of the frame wrongly marked as item
    ic = colour.analyse_image(rgb, leaky, th["colour"])
    assert ic.background_excluded > 0.3
    assert ic.dominant.lab[0] < 25  # still the black sweater, not the bed cover


def test_gray_world_is_used_without_a_white_surface(th):
    rgb, _ = render_scene(NAVY, bg=(150, 120, 96))  # tan wooden table: too saturated to be paper
    ic, _ = _analyse(rgb, th)
    assert ic.white_balance.reference_used is False
    assert ic.white_balance.method == "gray_world"


def test_white_balance_removes_a_warm_cast(th):
    rgb, _ = render_scene(NAVY)
    plain, _ = _analyse(rgb, th)
    warm, _ = _analyse(colour_cast(rgb, (1.0, 0.85, 0.65)), th)
    assert colour.ciede2000(plain.dominant.lab, warm.dominant.lab) < 3.0
    assert warm.white_balance.cast_strength > plain.white_balance.cast_strength


def test_same_colour_agrees_surely(th, navy_listing):
    ic, m = _analyse(render_scene(NAVY)[0], th)
    out = colour.compare(ic, [navy_listing], "Navy", th["colour"], m.reliable)
    assert out["finding"] == "agree"
    assert out["confidence"] == "sure"
    assert out["named_agreement"] is True
    assert out["observed_name"] in ("navy", "midnight blue")
    assert out["delta_e"] <= th["colour"]["match_max_de"]
    assert out["light_quality"] == "good"


def test_black_delivered_for_navy_is_a_sure_disagreement_in_good_light(th, navy_listing):
    ic, m = _analyse(render_scene(BLACK)[0], th)
    out = colour.compare(ic, [navy_listing], "navy", th["colour"], m.reliable)
    assert out["finding"] == "disagree"
    assert out["confidence"] == "sure"
    assert out["observed_name"] == "black"
    assert out["named_agreement"] is False


def test_dim_light_lowers_confidence(th, navy_listing):
    ic, m = _analyse(dim(render_scene(BLACK)[0], 0.12), th)
    out = colour.compare(ic, [navy_listing], "navy", th["colour"], m.reliable)
    assert out["light_quality"] == "dim"
    assert "dim" in out["light_reasons"]
    assert out["finding"] == "disagree"
    assert out["confidence"] == "fairly_sure"


def test_very_low_light_abstains(th, navy_listing):
    ic, m = _analyse(dim(render_scene(NAVY)[0], 0.02), th)
    out = colour.compare(ic, [navy_listing], "navy", th["colour"], m.reliable)
    assert out["finding"] == "unknown"
    assert out["abstain_reason"] == "low_light"
    assert out["delta_e"] is None


def test_heavy_colour_cast_abstains(th, navy_listing):
    rgb = colour_cast(render_scene(NAVY, bg=(200, 200, 200))[0], (1.0, 0.55, 0.25))
    ic, m = _analyse(rgb, th)
    out = colour.compare(ic, [navy_listing], "navy", th["colour"], m.reliable)
    assert out["finding"] == "unknown"
    assert out["abstain_reason"] == "heavy_cast"


def test_a_large_difference_is_sure_even_without_a_colour_name(th, navy_listing):
    ic, m = _analyse(render_scene(RED)[0], th)
    out = colour.compare(ic, [navy_listing], None, th["colour"], m.reliable)
    assert out["finding"] == "disagree"
    assert out["confidence"] == "sure"
    assert out["named_agreement"] is None


def test_name_only_is_never_sure(th):
    ic, m = _analyse(render_scene(BLACK)[0], th)
    out = colour.compare(ic, [], "navy", th["colour"], m.reliable)
    assert out["finding"] == "disagree"
    assert out["confidence"] == "fairly_sure"


def test_listing_photo_and_name_conflict_abstains(th, navy_listing):
    # The listing photo shows navy but the listing says red; a navy item cannot be judged.
    ic, m = _analyse(render_scene(NAVY)[0], th)
    out = colour.compare(ic, [navy_listing], "red", th["colour"], m.reliable)
    assert out["finding"] == "unknown"
    assert out["abstain_reason"] == "photo_and_name_disagree"


def test_nothing_to_compare(th):
    ic, m = _analyse(render_scene(NAVY)[0], th)
    out = colour.compare(ic, [], None, th["colour"], m.reliable)
    assert out["finding"] == "unknown"
    assert out["abstain_reason"] == "nothing_to_compare"


def test_unreliable_mask_lowers_confidence(th, navy_listing):
    ic, _ = _analyse(render_scene(NAVY)[0], th)
    out = colour.compare(ic, [navy_listing], "navy", th["colour"], mask_reliable=False)
    assert out["confidence"] == "fairly_sure"
