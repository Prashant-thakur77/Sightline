from __future__ import annotations

import statistics
import time

import cv2
import pytest

from app import quality

from synth import NAVY, add_glare, blur, dim, render_scene


@pytest.fixture(scope="module")
def scene():
    return render_scene(NAVY)


def test_good_photo_is_ok(scene):
    q = quality.assess(scene[0])
    assert q.code == "OK"
    assert q.issues == []
    assert q.guidance == "Hold still, capturing."


@pytest.mark.parametrize(
    "variant,code",
    [
        ("dark", "TOO_DARK"),
        ("blurred", "BLURRY"),
        ("glare", "GLARE"),
        ("far", "TOO_FAR"),
        ("close", "TOO_CLOSE"),
        ("filled", "TOO_CLOSE"),
    ],
)
def test_problem_photos_get_the_right_code(scene, variant, code):
    rgb, m = scene
    frames = {
        "dark": lambda: dim(rgb, 0.04),
        "blurred": lambda: blur(rgb, 4.0),
        "glare": lambda: add_glare(rgb, m, 0.12),
        "far": lambda: render_scene(NAVY, scale=0.35)[0],
        "close": lambda: render_scene(NAVY, scale=2.0)[0],
        "filled": lambda: render_scene(NAVY, scale=3.0)[0],
    }
    q = quality.assess(frames[variant]())
    assert q.code == code, q.metrics
    assert q.issues[0] == code


def test_guidance_wording():
    assert quality.GUIDANCE == {
        "TOO_DARK": "Too dark. Can you turn on a light?",
        "BLURRY": "Hold still for a moment.",
        "GLARE": "There's a glare. Tilt the phone a little.",
        "TOO_FAR": "Move the phone closer.",
        "TOO_CLOSE": "Move the phone back a little.",
        "OK": "Hold still, capturing.",
    }


def test_darkness_is_reported_before_blur(scene):
    q = quality.assess(blur(dim(scene[0], 0.03), 4.0))
    assert q.code == "TOO_DARK"
    assert "BLURRY" in q.issues


def test_metrics_are_reported(scene):
    q = quality.assess(scene[0]).to_dict()
    for key in ("mean_luma", "p99_luma", "sharpness", "glare_ratio", "coverage", "clip_low", "clip_high"):
        assert key in q["metrics"]
    assert 0.15 < q["metrics"]["coverage"] < 0.5


def test_frames_are_downscaled_and_fast(scene):
    big = cv2.resize(scene[0], (1280, 960), interpolation=cv2.INTER_LINEAR)
    quality.assess(big)  # warm-up
    times = []
    for _ in range(7):
        start = time.perf_counter()
        quality.assess(big)
        times.append((time.perf_counter() - start) * 1000)
    assert statistics.median(times) < 50.0
