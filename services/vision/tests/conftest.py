from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

# Tests never reach a real model, and never warm the OCR model in a background thread.
os.environ.pop("ANTHROPIC_API_KEY", None)
os.environ.pop("VISION_MODEL", None)
os.environ["VISION_WARM_OCR"] = "0"


@pytest.fixture(scope="session")
def th():
    from app.config import thresholds

    return thresholds()


@pytest.fixture(scope="session")
def ocr_engine():
    """The real RapidOCR engine, shared across tests (loading it takes about a second)."""
    from app.label import RapidOcrEngine

    engine = RapidOcrEngine()
    engine.warm_up()
    return engine
