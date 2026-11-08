"""Size label module: two independent reads of the size tag.

Read A is the vision model's structured read. Read B is OCR (RapidOCR: PP-OCR models on ONNX
Runtime, CPU only, models ship inside the wheel). When read A gives a box for the size, OCR re-reads
that crop; otherwise it reads the whole tag photo. Both reads are normalised (``Medium``, ``MED``
and ``M`` are the same size; ``M/38`` carries a letter and a number). A ``sure`` size needs both
reads to agree. If they disagree the module says ``not_sure``; with only one read it is at most
``fairly_sure``.
"""

from __future__ import annotations

import logging
import os
import re
import threading
from dataclasses import dataclass, field
from typing import Any, Protocol

import cv2
import numpy as np

from .imageio import encode_jpeg
from .vlm import ImagePart, VlmClient, VlmUnavailable

log = logging.getLogger(__name__)

# --------------------------------------------------------------------------------------------
# Size normalisation
# --------------------------------------------------------------------------------------------

_LETTER_WORDS: dict[str, tuple[str, ...]] = {
    "XXS": ("XXS", "2XS", "XX SMALL", "XXSMALL", "EXTRA EXTRA SMALL"),
    "XS": ("XS", "X SMALL", "XSMALL", "EXTRA SMALL", "XSM"),
    "S": ("S", "SM", "SML", "SMALL"),
    "M": ("M", "MD", "MED", "MEDIUM", "MDM"),
    "L": ("L", "LG", "LRG", "LARGE"),
    "XL": ("XL", "X LARGE", "XLARGE", "EXTRA LARGE", "XLG"),
    "XXL": ("XXL", "2XL", "XX LARGE", "XXLARGE", "EXTRA EXTRA LARGE"),
    "XXXL": ("XXXL", "3XL", "XXX LARGE"),
    "4XL": ("4XL", "XXXXL"),
    "5XL": ("5XL", "XXXXXL"),
    "OS": ("OS", "ONE SIZE", "ONESIZE", "O S"),
}
_WORD_TO_LETTER = {w: letter for letter, words in _LETTER_WORDS.items() for w in words}
_SYSTEMS = ("EU", "EUR", "US", "UK", "IT", "FR", "DE", "JP", "AU", "MX", "CN")
_SYSTEM_ALIASES = {"EUR": "EU"}
_KEYWORDS = r"(?:SIZE|SZ|TAILLE|TALLA|TAGLIA|GROESSE|GROSSE|GR)"
_NUMERIC = re.compile(
    r"^(?:(?P<pre>" + "|".join(_SYSTEMS) + r"|W|L)\s*)?(?P<num>\d{1,3}(?:[.,]5)?)\s*(?P<post>" + "|".join(_SYSTEMS) + r"|W|L)?$"
)


@dataclass(frozen=True)
class Size:
    letter: str | None = None
    numeric: tuple[tuple[str | None, str], ...] = ()
    raw: str = ""

    @property
    def canonical(self) -> str:
        if self.letter and self.numeric:
            return self.letter + "/" + "/".join(_fmt_num(s, v) for s, v in self.numeric)
        if self.letter:
            return self.letter
        return "/".join(_fmt_num(s, v) for s, v in self.numeric)

    @property
    def spoken(self) -> str:
        """The part people say out loud: the letter if there is one."""
        if self.letter:
            return self.letter
        return self.canonical


def _fmt_num(system: str | None, value: str) -> str:
    return f"{system} {value}" if system else value


def _clean(text: str) -> str:
    t = text.upper().replace("Ö", "OE")
    t = re.sub(r"[-_:;]|\.(?!\d)|(?<!\d)\.", " ", t)  # keep decimal points ("8.5")
    return re.sub(r"\s+", " ", t).strip()


def _parse_part(part: str) -> tuple[str | None, tuple[str | None, str] | None]:
    p = part.strip()
    if not p:
        return None, None
    if p in _WORD_TO_LETTER:
        return _WORD_TO_LETTER[p], None
    compact = p.replace(" ", "")
    if compact in _WORD_TO_LETTER:
        return _WORD_TO_LETTER[compact], None
    m = _NUMERIC.match(p)
    if m:
        system = m.group("pre") or m.group("post")
        if system in ("W", "L"):
            system = None
        system = _SYSTEM_ALIASES.get(system or "", system)
        value = m.group("num").replace(",", ".")
        return None, (system, value)
    return None, None


def parse_size(text: str | None) -> Size | None:
    """Normalise a size string. Returns ``None`` unless every part is a recognised size token."""
    if not text:
        return None
    t = _clean(text)
    t = re.sub(r"^" + _KEYWORDS + r"\s*", "", t)
    if not t:
        return None
    parts = [p for p in re.split(r"\s*[/|(),]\s*|\s+-\s+", t) if p.strip()]
    if not parts:
        return None
    letter: str | None = None
    numerics: list[tuple[str | None, str]] = []
    for part in parts:
        lt, num = _parse_part(part)
        if lt is None and num is None and " " in part:
            # "M 38": every space-separated token is a size on its own.
            tokens = [_parse_part(tok) for tok in part.split()]
            if all(tl is not None or tn is not None for tl, tn in tokens):
                for tl, tn in tokens:
                    if tl is not None:
                        if letter is not None and letter != tl:
                            return None
                        letter = tl
                    if tn is not None:
                        numerics.append(tn)
                continue
        if lt is None and num is None:
            # "EU 40 UK 12" without separators
            sub = re.findall(r"(?:" + "|".join(_SYSTEMS) + r")\s*\d{1,3}(?:[.,]5)?", part)
            if sub and "".join(s.replace(" ", "") for s in sub) == part.replace(" ", ""):
                for s in sub:
                    _, n = _parse_part(s)
                    if n:
                        numerics.append(n)
                continue
            return None
        if lt is not None:
            if letter is not None and letter != lt:
                return None
            letter = lt
        if num is not None:
            numerics.append(num)
    return Size(letter=letter, numeric=tuple(numerics), raw=text.strip())


def compare_sizes(expected: Size, observed: Size) -> str:
    """``same`` | ``different`` | ``not_comparable`` (letters vs numbers, or different systems)."""
    if expected.letter and observed.letter:
        return "same" if expected.letter == observed.letter else "different"
    if expected.numeric and observed.numeric:
        if all(s is None for s, _ in expected.numeric) and all(s is None for s, _ in observed.numeric):
            return "same" if [v for _, v in expected.numeric] == [v for _, v in observed.numeric] else "different"
        verdicts = set()
        for es, ev in expected.numeric:
            for os_, ov in observed.numeric:
                if es == os_ or es is None or os_ is None:
                    verdicts.add("same" if ev == ov else "different")
        if "same" in verdicts:
            return "same"
        if "different" in verdicts:
            return "different"
    return "not_comparable"


# --------------------------------------------------------------------------------------------
# OCR (read B)
# --------------------------------------------------------------------------------------------


@dataclass
class OcrLine:
    text: str
    score: float
    box: tuple[float, float, float, float]  # x0, y0, x1, y1 as fractions of the image

    def to_dict(self) -> dict[str, Any]:
        return {"text": self.text, "score": round(self.score, 4), "box": [round(v, 4) for v in self.box]}


class OcrEngine(Protocol):
    name: str
    available: bool

    def read(self, rgb: np.ndarray) -> list[OcrLine]: ...

    def read_line(self, rgb: np.ndarray) -> OcrLine | None: ...


class NullOcr:
    name = "none"
    available = False

    def read(self, rgb: np.ndarray) -> list[OcrLine]:
        return []

    def read_line(self, rgb: np.ndarray) -> OcrLine | None:
        return None


class RapidOcrEngine:
    """RapidOCR (PP-OCRv4 detection + recognition on ONNX Runtime). Loaded on first use."""

    name = "rapidocr"
    available = True

    def __init__(self) -> None:
        self._engine: Any = None
        self._lock = threading.Lock()

    def _get(self) -> Any:
        if self._engine is None:
            from rapidocr_onnxruntime import RapidOCR

            threads = os.environ.get("VISION_OCR_THREADS", "").strip()
            kwargs = {"intra_op_num_threads": int(threads), "inter_op_num_threads": 1} if threads.isdigit() else {}
            self._engine = RapidOCR(**kwargs)
        return self._engine

    def warm_up(self) -> None:
        with self._lock:
            self._get()

    def read(self, rgb: np.ndarray) -> list[OcrLine]:
        h, w = rgb.shape[:2]
        with self._lock:
            result, _ = self._get()(np.ascontiguousarray(rgb[..., ::-1]))
        lines: list[OcrLine] = []
        for box, text, score in result or []:
            pts = np.asarray(box, dtype=np.float64)
            x0, y0 = pts.min(axis=0)
            x1, y1 = pts.max(axis=0)
            lines.append(OcrLine(text=str(text), score=float(score), box=(float(x0 / w), float(y0 / h), float(x1 / w), float(y1 / h))))
        return lines

    def read_line(self, rgb: np.ndarray) -> OcrLine | None:
        with self._lock:
            result, _ = self._get()(np.ascontiguousarray(rgb[..., ::-1]), use_det=False, use_cls=False, use_rec=True)
        if not result:
            return None
        text, score = result[0][0], result[0][1]
        return OcrLine(text=str(text), score=float(score), box=(0.0, 0.0, 1.0, 1.0))


_ocr_singleton: OcrEngine | None = None
_ocr_lock = threading.Lock()


def get_ocr_engine() -> OcrEngine:
    global _ocr_singleton
    with _ocr_lock:
        if _ocr_singleton is None:
            if os.environ.get("VISION_OCR", "rapidocr").lower() in ("off", "none", "0"):
                _ocr_singleton = NullOcr()
            else:
                try:
                    import rapidocr_onnxruntime  # noqa: F401

                    _ocr_singleton = RapidOcrEngine()
                except ImportError:
                    log.warning("RapidOCR is not installed; size tags get a single read")
                    _ocr_singleton = NullOcr()
        return _ocr_singleton


@dataclass
class SizeCandidate:
    size: Size
    priority: int  # 2: after a SIZE keyword, 1: a line that is only a size, 0: a bare number
    height: float
    score: float
    text: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "size": self.size.canonical,
            "priority": self.priority,
            "height": round(self.height, 4),
            "score": round(self.score, 4),
            "text": self.text,
        }


def extract_size(lines: list[OcrLine]) -> tuple[Size | None, list[SizeCandidate]]:
    """Pick the size out of OCR lines. Ambiguous tags (two different sizes) give ``None``."""
    cands: list[SizeCandidate] = []
    keyword_pending = False
    ordered = sorted(lines, key=lambda ln: (ln.box[1], ln.box[0]))
    for line in ordered:
        t = _clean(line.text)
        height = line.box[3] - line.box[1]
        if keyword_pending:
            keyword_pending = False
            s = parse_size(t)
            if s:
                cands.append(SizeCandidate(s, 2, height, line.score, line.text))
                continue
        m = re.match(r"^" + _KEYWORDS + r"\s*(.*)$", t)
        if m and m.group(0).startswith(("SIZE", "SZ", "TAILLE", "TALLA", "TAGLIA", "GROESSE", "GROSSE")):
            rest = m.group(1).strip()
            if not rest:
                keyword_pending = True
                continue
            s = parse_size(rest)
            if s:
                cands.append(SizeCandidate(s, 2, height, line.score, line.text))
            continue
        if len(t) <= 14:
            s = parse_size(t)
            if s:
                bare = s.letter is None and all(sys is None for sys, _ in s.numeric)
                cands.append(SizeCandidate(s, 0 if bare else 1, height, line.score, line.text))
    if not cands:
        return None, []
    top = max(c.priority for c in cands)
    best = [c for c in cands if c.priority == top]
    best.sort(key=lambda c: -c.height)
    leader = best[0]
    for other in best[1:]:
        if compare_sizes(leader.size, other.size) == "different" and other.height >= 0.8 * leader.height:
            return None, cands
    return leader.size, cands


def _overlap(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> float:
    w = min(a[2], b[2]) - max(a[0], b[0])
    h = min(a[3], b[3]) - max(a[1], b[1])
    return max(0.0, w) * max(0.0, h)


def _tag_region(gray: np.ndarray) -> np.ndarray:
    """The label itself when it stands out from the garment around it, else the whole image."""
    h, w = gray.shape
    _, bw = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    whole = np.ones((h, w), bool)
    for polarity in (bw == 255, bw == 0):
        n, labels, stats, _ = cv2.connectedComponentsWithStats(polarity.astype(np.uint8), connectivity=8)
        if n <= 1:
            continue
        best = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
        area = stats[best, cv2.CC_STAT_AREA]
        x, y, cw, ch = (int(v) for v in stats[best, :4])
        touches = x <= 1 or y <= 1 or x + cw >= w - 1 or y + ch >= h - 1
        if 0.08 * h * w <= area <= 0.85 * h * w and not touches:
            contours, _ = cv2.findContours((labels == best).astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            filled = np.zeros((h, w), np.uint8)
            cv2.drawContours(filled, contours, -1, 1, thickness=cv2.FILLED)
            # Stay clear of the label's edge and stitching.
            k = max(3, int(0.03 * min(cw, ch)))
            return cv2.erode(filled, np.ones((k, k), np.uint8)) > 0
    return whole


def large_glyph_lines(ocr: OcrEngine, rgb: np.ndarray, known: list[OcrLine], max_groups: int = 3) -> list[OcrLine]:
    """Recognise the biggest printed glyphs on the label, one block at a time.

    Text detectors can miss a lone, thin letter such as a large "L" on a size tag (or return one
    meaningless box over the whole tag). Find the label, binarise it, take the tallest ink blobs
    (dark-on-light or light-on-dark), group neighbours into words, and run recognition only on each
    group: cropped, cleaned to black on white, padded and upscaled.
    """
    h, w = rgb.shape[:2]
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    region = _tag_region(gray)
    vals = gray[region]
    if vals.size < 100:
        return []
    t, _ = cv2.threshold(vals.reshape(1, -1), 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    dark = gray < t
    ink_dark = (dark & region).sum() < 0.5 * region.sum()
    ink = (dark if ink_dark else ~dark) & region
    ys, xs = np.nonzero(region)
    region_h = float(ys.max() - ys.min() + 1)
    n, _, stats, _ = cv2.connectedComponentsWithStats(ink.astype(np.uint8), connectivity=8)
    # Only confident detections count as already read; a junk box over the whole tag does not.
    known_px = [(ln.box[0] * w, ln.box[1] * h, ln.box[2] * w, ln.box[3] * h) for ln in known if ln.score >= 0.5]
    comps: list[tuple[float, float, float, float]] = []
    for i in range(1, n):
        x, y, cw, ch, area = (int(v) for v in stats[i])
        if not (0.08 * region_h <= ch <= 0.9 * region_h and cw <= 0.9 * w and area >= 0.0005 * h * w):
            continue
        box = (float(x), float(y), float(x + cw), float(y + ch))
        if any(_overlap(box, k) > 0.5 * cw * ch for k in known_px):
            continue
        comps.append(box)
    comps.sort(key=lambda b: b[0])
    groups: list[list[float]] = []
    for b in comps:
        if groups:
            g = groups[-1]
            v_overlap = min(g[3], b[3]) - max(g[1], b[1])
            if v_overlap > 0.5 * min(g[3] - g[1], b[3] - b[1]) and b[0] - g[2] < 0.6 * max(g[3] - g[1], b[3] - b[1]):
                groups[-1] = [min(g[0], b[0]), min(g[1], b[1]), max(g[2], b[2]), max(g[3], b[3])]
                continue
        groups.append(list(b))
    groups.sort(key=lambda g: -(g[3] - g[1]))
    out: list[OcrLine] = []
    for x0, y0, x1, y1 in groups[:max_groups]:
        xa, ya, xb, yb = int(x0), int(y0), int(x1), int(y1)
        glyph = ink[ya:yb, xa:xb]
        clean = np.where(glyph, 0, 255).astype(np.uint8)
        pad = max(8, int(0.25 * (yb - ya)))
        clean = cv2.copyMakeBorder(clean, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=255)
        if clean.shape[0] < 96:
            scale = 96 / clean.shape[0]
            clean = cv2.resize(clean, (max(1, int(clean.shape[1] * scale)), 96), interpolation=cv2.INTER_CUBIC)
        line = ocr.read_line(cv2.cvtColor(clean, cv2.COLOR_GRAY2RGB))
        if line is not None and line.text.strip():
            out.append(OcrLine(line.text, line.score, (xa / w, ya / h, xb / w, yb / h)))
    return out


def ocr_size(ocr: OcrEngine, rgb: np.ndarray) -> tuple[Size | None, list[SizeCandidate], list[OcrLine]]:
    """OCR one image and pick the size, with the big-glyph fallback when nothing is found."""
    lines = ocr.read(rgb)
    size, cands = extract_size(lines)
    if size is None and not any(c.priority >= 1 for c in cands):
        extra = large_glyph_lines(ocr, rgb, lines)
        if extra:
            lines = lines + extra
            size, cands = extract_size(lines)
    return size, cands, lines


# --------------------------------------------------------------------------------------------
# The module
# --------------------------------------------------------------------------------------------


@dataclass
class LabelReads:
    read_a: dict[str, Any] = field(default_factory=dict)
    read_b: dict[str, Any] = field(default_factory=dict)


def _vlm_read(vlm: VlmClient, rgb: np.ndarray) -> dict[str, Any]:
    out: dict[str, Any] = {"source": "vlm", "engine": vlm.name, "available": bool(vlm.available), "size": None}
    try:
        data = vlm.read_label(ImagePart(encode_jpeg(rgb), "image/jpeg"))
    except VlmUnavailable as exc:
        out["error"] = str(exc)
        return out
    raw_size = str(data.get("size") or "").strip()
    parsed = parse_size(raw_size)
    out.update(
        {
            "size_raw": raw_size,
            "size": parsed.canonical if parsed else None,
            "brand": str(data.get("brand") or ""),
            "material": str(data.get("material") or ""),
            "raw_text": str(data.get("raw_text") or ""),
            "boxes": [b for b in data.get("boxes") or [] if isinstance(b, dict)],
        }
    )
    out["_parsed"] = parsed
    return out


def _size_box(read_a: dict[str, Any]) -> tuple[float, float, float, float] | None:
    for b in read_a.get("boxes") or []:
        box = b.get("box")
        if b.get("label") == "size" and isinstance(box, list) and len(box) == 4:
            try:
                x0, y0, x1, y1 = (float(v) for v in box)
            except (TypeError, ValueError):
                return None
            if 0 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1:
                return x0, y0, x1, y1
    return None


def _crop(rgb: np.ndarray, box: tuple[float, float, float, float], pad: float) -> np.ndarray:
    h, w = rgb.shape[:2]
    x0, y0, x1, y1 = box
    bw, bh = x1 - x0, y1 - y0
    xa, xb = max(0, int((x0 - pad * bw) * w)), min(w, int((x1 + pad * bw) * w) + 1)
    ya, yb = max(0, int((y0 - pad * bh) * h)), min(h, int((y1 + pad * bh) * h) + 1)
    return rgb[ya:yb, xa:xb]


def _ocr_read(ocr: OcrEngine, rgb: np.ndarray, box: tuple[float, float, float, float] | None, th: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {"source": "ocr", "engine": ocr.name, "available": bool(ocr.available), "size": None, "used_crop": False}
    if not ocr.available:
        out["error"] = "no OCR engine"
        return out
    try:
        size: Size | None = None
        cands: list[SizeCandidate] = []
        lines: list[OcrLine] = []
        score = 0.0
        if box is not None:
            crop = _crop(rgb, box, float(th["crop_padding"]))
            if crop.size:
                size, cands, lines = ocr_size(ocr, crop)
                if size is None:
                    line = ocr.read_line(crop)
                    if line is not None:
                        size = parse_size(line.text)
                        lines = [line]
                        if size:
                            cands = [SizeCandidate(size, 1, 1.0, line.score, line.text)]
                out["used_crop"] = size is not None
        if size is None:
            size, cands, lines = ocr_size(ocr, rgb)
        if size is not None:
            chosen = next(c for c in cands if c.size == size)
            score = chosen.score
        out.update(
            {
                "size": size.canonical if size else None,
                "score": round(score, 4),
                "candidates": [c.to_dict() for c in cands],
                "lines": [ln.to_dict() for ln in lines],
            }
        )
        out["_parsed"] = size
        if size is not None and score < float(th["ocr_min_score"]):
            out["low_score"] = True
    except Exception as exc:  # noqa: BLE001 - OCR failure must not fail the whole check
        log.warning("OCR failed: %s", exc)
        out["error"] = "OCR failed"
    return out


def check_size(
    label_rgb: np.ndarray | None,
    expected_text: str | None,
    vlm: VlmClient,
    ocr: OcrEngine,
    th: dict[str, Any],
) -> dict[str, Any]:
    """Run both reads of the tag and compare the result with the size that was ordered."""
    expected = parse_size(expected_text)
    out: dict[str, Any] = {
        "expected": expected.canonical if expected else (expected_text or None),
        "expected_spoken": expected.spoken if expected else (expected_text or None),
        "observed": None,
        "observed_spoken": None,
        "read_a": None,
        "read_b": None,
        "reads_agree": None,
        "finding": "unknown",
        "confidence": "not_sure",
        "reason": None,
    }
    if label_rgb is None:
        out["reason"] = "no_label_photo"
        return out

    read_a = _vlm_read(vlm, label_rgb)
    read_b = _ocr_read(ocr, label_rgb, _size_box(read_a), th)
    a: Size | None = read_a.pop("_parsed", None)
    b: Size | None = read_b.pop("_parsed", None)
    out["read_a"], out["read_b"] = read_a, read_b

    observed: Size | None
    if a is not None and b is not None:
        agree = compare_sizes(a, b) == "same"
        out["reads_agree"] = agree
        if not agree:
            out["reason"] = "reads_disagree"
            out["candidates"] = [a.canonical, b.canonical]
            return out
        observed = a if (a.letter or not b.letter) else b
        read_conf = "sure" if not read_b.get("low_score") else "fairly_sure"
    elif a is not None or b is not None:
        observed = a or b
        read_conf = "fairly_sure" if not read_b.get("low_score") or a is not None else "not_sure"
        out["reason"] = "single_read"
    else:
        out["reason"] = "unreadable"
        return out

    assert observed is not None
    out["observed"] = observed.canonical
    out["observed_spoken"] = observed.spoken
    if expected is None:
        out["reason"] = "listing_has_no_size" if not expected_text else "listing_size_unrecognised"
        return out
    verdict = compare_sizes(expected, observed)
    if verdict == "not_comparable":
        out["reason"] = "different_size_systems"
        return out
    out["finding"] = "agree" if verdict == "same" else "disagree"
    out["confidence"] = read_conf
    return out
