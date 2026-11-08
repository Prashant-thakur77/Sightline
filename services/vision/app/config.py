"""Thresholds and limits.

Every decision threshold lives in ``thresholds.json`` so it can be refitted on the dev split
without touching code. ``VISION_THRESHOLDS`` points at a different file (used by evals).
"""

from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path
from typing import Any

DEFAULT_THRESHOLDS_PATH = Path(__file__).with_name("thresholds.json")


def _deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    out = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge(out[key], value)
        else:
            out[key] = value
    return out


def load_thresholds(path: str | os.PathLike[str] | None = None) -> dict[str, Any]:
    """Load the default thresholds, overlaid with ``path`` (or ``$VISION_THRESHOLDS``) if given.

    An override file only needs the keys it changes.
    """
    with DEFAULT_THRESHOLDS_PATH.open(encoding="utf-8") as fh:
        data: dict[str, Any] = json.load(fh)
    override_path = path or os.environ.get("VISION_THRESHOLDS")
    if override_path:
        with Path(override_path).open(encoding="utf-8") as fh:
            data = _deep_merge(data, json.load(fh))
    return data


@lru_cache(maxsize=1)
def thresholds() -> dict[str, Any]:
    """Process-wide thresholds (cached)."""
    return load_thresholds()


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


class Limits:
    """Upload limits. Read once at import; tests construct their own if needed."""

    max_file_bytes: int = _env_int("VISION_MAX_FILE_MB", 10) * 1024 * 1024
    max_request_bytes: int = _env_int("VISION_MAX_REQUEST_MB", 40) * 1024 * 1024
    max_pixels: int = 40_000_000
    max_item_photos: int = 4
    max_listing_images: int = 4
    max_listing_urls: int = 4
    url_timeout_s: float = 8.0
    # Working resolution for verification and for the live quality hints.
    verify_max_side: int = 1024
    quality_max_side: int = 320
