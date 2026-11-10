from __future__ import annotations

import json

import pytest

from app import bench

from synth import BLACK, NAVY, listing_image, render_scene, render_tag, to_jpeg, to_png


def test_wilson_interval():
    assert bench.wilson(0, 0) is None
    lo, hi = bench.wilson(5, 10)
    assert lo == pytest.approx(0.2366, abs=1e-4) and hi == pytest.approx(0.7634, abs=1e-4)
    lo, hi = bench.wilson(0, 10)
    assert lo == 0.0 and hi == pytest.approx(0.2775, abs=1e-4)


def test_metrics_from_rows():
    rows = [
        {"expected": "mismatch", "predicted": "mismatch", "mismatch_type": "size", "lighting": "good", "ms": 100},
        {"expected": "mismatch", "predicted": "unsure", "mismatch_type": "colour", "lighting": "dim", "ms": 200},
        {"expected": "match", "predicted": "match", "lighting": "good", "ms": 300},
        {"expected": "match", "predicted": "mismatch", "lighting": "dim", "ms": 400},
    ]
    m = bench.compute_metrics(rows)
    o = m["overall"]
    assert o["mismatch_recall"]["value"] == 0.5
    assert o["false_alarm_rate"]["value"] == 0.5
    assert o["abstention_rate"]["value"] == 0.25
    assert o["accuracy_when_decided"]["value"] == pytest.approx(2 / 3, abs=1e-4)
    assert m["per_mismatch_type"]["size"]["mismatch_recall"]["value"] == 1.0
    assert m["per_mismatch_type"]["colour"]["abstention_rate"]["value"] == 1.0
    assert m["per_lighting"]["dim"]["false_alarm_rate"]["value"] == 1.0
    assert m["latency_ms"] == {"p50": 200, "p95": 400}


def test_cli_runs_a_manifest(tmp_path, capsys):
    (tmp_path / "img").mkdir()
    (tmp_path / "img/navy.jpg").write_bytes(to_jpeg(render_scene(NAVY)[0]))
    (tmp_path / "img/black.jpg").write_bytes(to_jpeg(render_scene(BLACK)[0]))
    (tmp_path / "img/listing.jpg").write_bytes(to_jpeg(listing_image(NAVY)))
    (tmp_path / "img/tag_m.png").write_bytes(to_png(render_tag(["HARBOR", "M"], [34, 150])))
    listing = {"title": "Harbor knit crew-neck sweater", "colour": "navy", "size": "M"}
    manifest = {
        "name": "tiny",
        "pairs": [
            {
                "id": "a",
                "item": ["img/navy.jpg"],
                "label": "img/tag_m.png",
                "listing_images": ["img/listing.jpg"],
                "listing": listing,
                "expected": "match",
                "lighting": "good",
            },
            {
                "id": "b",
                "item": "img/black.jpg",
                "label": "img/tag_m.png",
                "listing_images": ["img/listing.jpg"],
                "listing": listing,
                "expected": "mismatch",
                "mismatch_type": "colour",
                "lighting": "good",
            },
            {"id": "c", "item": ["img/missing.jpg"], "listing": listing, "expected": "mismatch", "mismatch_type": "size"},
        ],
    }
    path = tmp_path / "manifest.json"
    path.write_text(json.dumps(manifest))
    out = tmp_path / "results/metrics.json"
    assert bench.main(["--manifest", str(path), "--out", str(out), "--no-vlm"]) == 0
    report = json.loads(out.read_text())
    assert report["suite"] == "tiny"
    assert report["engines"] == {"vlm": "none"}
    rows = {r["id"]: r for r in report["pairs"]}
    assert rows["a"]["predicted"] == "unsure"  # no vision model: identity cannot be checked
    # Black for navy in good light: one look by one module, so "not sure" with a retake asked for.
    assert rows["b"]["predicted"] == "unsure"
    assert rows["c"]["error"].startswith("FileNotFoundError")
    o = report["metrics"]["overall"]
    assert o["n"] == 3
    assert o["mismatch_recall"]["value"] == 0.0
    assert o["false_alarm_rate"]["value"] == 0.0
    assert report["metrics"]["errors"] == 1
    assert "mismatch recall" in capsys.readouterr().out


def test_cli_rejects_unknown_modules(tmp_path):
    with pytest.raises(SystemExit):
        bench.main(["--manifest", str(tmp_path / "m.json"), "--disable", "telepathy"])


def test_ablation_disables_a_module(tmp_path):
    (tmp_path / "black.jpg").write_bytes(to_jpeg(render_scene(BLACK)[0]))
    (tmp_path / "listing.jpg").write_bytes(to_jpeg(listing_image(NAVY)))
    manifest = [{"id": "b", "item": "black.jpg", "listing_images": ["listing.jpg"], "listing": {"colour": "navy"}, "expected": "mismatch"}]
    (tmp_path / "m.json").write_text(json.dumps(manifest))
    report = bench.run_manifest(tmp_path / "m.json", use_vlm=False, disabled={"colour"})
    assert report["pairs"][0]["predicted"] == "unsure"
    assert report["disabled_modules"] == ["colour"]
