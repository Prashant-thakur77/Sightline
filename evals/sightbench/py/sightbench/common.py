"""Paths, hashing and the test-split freeze check shared by the generator and the CLIP baseline."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

PY_DIR = Path(__file__).resolve().parent.parent
SIGHTBENCH_DIR = PY_DIR.parent
EVALS_DIR = SIGHTBENCH_DIR.parent
REPO_ROOT = EVALS_DIR.parent
MANIFEST_DIR = SIGHTBENCH_DIR / "manifests"
RAW_DIR = EVALS_DIR / "data" / "raw" / "sightbench"
FREEZE_PATH = MANIFEST_DIR / "test.freeze.json"
CLIP_THRESHOLD_PATH = SIGHTBENCH_DIR / "clip-threshold.json"
CLIP_SCORES_PATH = RAW_DIR / "clip-scores.json"

SPLITS = ("dev", "test")


def manifest_path(split: str) -> Path:
    return MANIFEST_DIR / f"{split}.json"


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def rel(path: Path) -> str:
    """Repo-relative path with forward slashes."""
    return path.resolve().relative_to(REPO_ROOT).as_posix()


def load_manifest(split: str) -> dict[str, Any]:
    return json.loads(manifest_path(split).read_text(encoding="utf-8"))


def verify_freeze() -> dict[str, Any]:
    """Raise unless the test manifest still has the hash recorded when it was frozen."""
    if not FREEZE_PATH.exists():
        raise SystemExit(f"No freeze record at {rel(FREEZE_PATH)}. Generate the data first.")
    freeze = json.loads(FREEZE_PATH.read_text(encoding="utf-8"))
    actual = sha256_file(manifest_path("test"))
    if actual != freeze["sha256"]:
        raise SystemExit(f"Test manifest changed since it was frozen: {actual} != {freeze['sha256']}. Refusing to run.")
    return freeze


def resolve(manifest_file: Path, rel_path: str) -> Path:
    """Manifest paths are relative to the manifest file, as in services/vision app.bench."""
    return (manifest_file.parent / rel_path).resolve()
