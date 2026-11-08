from __future__ import annotations

import numpy as np
import pytest

from app.mask import item_mask

from synth import BLACK, NAVY, listing_image, render_scene, sweater_mask


def iou(a: np.ndarray, b: np.ndarray) -> float:
    return float((a & b).sum() / max(1, (a | b).sum()))


@pytest.mark.parametrize("colour", [NAVY, BLACK])
def test_grabcut_finds_the_item_on_a_table(colour):
    rgb, truth = render_scene(colour)
    m = item_mask(rgb)
    assert m.method == "grabcut"
    assert m.reliable
    assert m.mask.shape == truth.shape
    assert iou(m.mask, truth) > 0.9


def test_same_function_masks_listing_images():
    rgb = listing_image(NAVY)
    truth = sweater_mask(600, 600, 1.15, (0.5, 0.5))
    m = item_mask(rgb)
    assert iou(m.mask, truth) > 0.9


def test_off_centre_item_is_still_found():
    rgb, truth = render_scene(NAVY, scale=0.8, centre=(0.4, 0.5))
    assert iou(item_mask(rgb).mask, truth) > 0.85


def test_featureless_frame_falls_back_to_an_unreliable_centre_mask():
    rgb = np.full((300, 400, 3), 128, np.uint8)
    m = item_mask(rgb)
    assert m.method == "centre"
    assert m.reliable is False
    assert 0.1 < m.fraction < 0.5


def test_rembg_request_falls_back_to_grabcut_when_not_installed():
    rgb, truth = render_scene(NAVY)
    m = item_mask(rgb, method="rembg")
    assert m.method in ("grabcut", "rembg")
    assert iou(m.mask, truth) > 0.85
