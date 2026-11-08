"""Thresholds and limits.

Every decision threshold lives in ``thresholds.json`` (the default set, fitted on the SightBench dev
split) so it can be refitted without touching code. Earlier complete sets are kept in
``threshold_sets/`` by version name for reproducibility. ``VISION_THRESHOLDS`` is either a set name
(``initial-unfitted``), which replaces the default, or a path to an override file, which is overlaid
on the default and only needs the keys it changes.
"""

from __future__ import annotations

import json
import os
import re
from functools import lru_cache
from pathlib import Path
from typing import Any

DEFAULT_THRESHOLDS_PATH = Path(__file__).with_name("thresholds.json")
THRESHOLD_SETS_DIR = Path(__file__).with_name("threshold_sets")
_SET_NAME = re.compile(r"^[a-z0-9][a-z0-9-]*$")


def _deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    out = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge(out[key], value)
        else:
            out[key] = value
    return out


def threshold_set_names() -> list[str]:
    """Version names that ``VISION_THRESHOLDS`` accepts: the default set and every kept set."""
    with DEFAULT_THRESHOLDS_PATH.open(encoding="utf-8") as fh:
        default = str(json.load(fh).get("version"))
    return sorted({default, *(p.stem for p in THRESHOLD_SETS_DIR.glob("*.json"))})


def load_thresholds(path: str | os.PathLike[str] | None = None) -> dict[str, Any]:
    """Load the thresholds named or pointed to by ``path`` (or ``$VISION_THRESHOLDS``).

    Nothing given: the default set. A set name (``initial-unfitted``): that complete set, in place
    of the default. Anything else is a path to an override file overlaid on the default, which only
    needs the keys it changes.
    """
    with DEFAULT_THRESHOLDS_PATH.open(encoding="utf-8") as fh:
        data: dict[str, Any] = json.load(fh)
    override = path or os.environ.get("VISION_THRESHOLDS")
    if not override:
        return data
    name = str(override)
    if _SET_NAME.match(name):
        if name == data.get("version"):
            return data
        named = THRESHOLD_SETS_DIR / f"{name}.json"
        if not named.is_file():
            raise ValueError(f"Unknown threshold set {name!r}. Known sets: {', '.join(threshold_set_names())}.")
        with named.open(encoding="utf-8") as fh:
            named_data: dict[str, Any] = json.load(fh)
        return named_data
    with Path(override).open(encoding="utf-8") as fh:
        return _deep_merge(data, json.load(fh))


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
