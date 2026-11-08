"""Image intake: type checks, GPS stripping and decoding.

Every uploaded or fetched image goes through :func:`sanitize` first. Location data (the EXIF GPS
directory and any XMP packet) is removed before anything else reads the bytes; the capture time is
kept because the evidence pack needs it. JPEGs are rewritten at the segment level so the pixels are
not re-encoded. Other formats carrying metadata are re-encoded losslessly as PNG without it.
"""

from __future__ import annotations

import hashlib
import io
import struct
from dataclasses import dataclass

import numpy as np
from PIL import Image, ImageOps

from .config import Limits

Image.MAX_IMAGE_PIXELS = Limits.max_pixels

ALLOWED_MEDIA_TYPES = ("image/jpeg", "image/png", "image/webp")

_EXIF_GPS_IFD = 0x8825
_EXIF_IFD = 0x8769
_DATETIME_ORIGINAL = 0x9003
_DATETIME = 0x0132


class ImageError(ValueError):
    """An image we cannot accept. ``message`` is safe to show to the user."""

    def __init__(self, code: str, message: str, status: int = 422):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


@dataclass(frozen=True)
class SanitizedImage:
    data: bytes
    media_type: str
    sha256: str
    gps_removed: bool
    taken_at: str | None

    def meta(self) -> dict[str, object]:
        return {
            "sha256": self.sha256,
            "media_type": self.media_type,
            "bytes": len(self.data),
            "gps_removed": self.gps_removed,
            "taken_at": self.taken_at,
        }


def sniff_media_type(data: bytes) -> str | None:
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def check_type(data: bytes, declared: str | None) -> str:
    """Return the real media type, or raise if it is not an accepted image.

    The declared content type must be an image type we accept (or absent/generic), and the bytes
    must actually be that kind of file.
    """
    actual = sniff_media_type(data)
    declared_clean = (declared or "").split(";")[0].strip().lower()
    if declared_clean == "image/jpg":
        declared_clean = "image/jpeg"
    generic = declared_clean in ("", "application/octet-stream")
    if actual is None or (not generic and declared_clean not in ALLOWED_MEDIA_TYPES):
        raise ImageError(
            "unsupported_type",
            "That file isn't a photo I can read. Please send a JPEG, PNG or WebP picture.",
            status=415,
        )
    return actual


def _taken_at(exif: Image.Exif) -> str | None:
    try:
        sub = exif.get_ifd(_EXIF_IFD)
    except Exception:  # noqa: BLE001 - malformed EXIF is common; the timestamp is optional
        sub = {}
    value = sub.get(_DATETIME_ORIGINAL) or exif.get(_DATETIME)
    if not value:
        return None
    if isinstance(value, bytes):
        value = value.decode("ascii", "ignore")
    text = str(value).strip("\x00 ")
    return text or None


def _strip_jpeg(data: bytes) -> tuple[bytes, bool, str | None]:
    """Remove the GPS IFD from EXIF and drop XMP packets, without touching the image data."""
    out = bytearray(data[:2])
    pos = 2
    removed = False
    taken_at: str | None = None
    n = len(data)
    while pos + 4 <= n:
        if data[pos] != 0xFF:
            # Not a marker where one was expected: keep the rest as-is.
            out += data[pos:]
            return bytes(out), removed, taken_at
        marker = data[pos + 1]
        if marker == 0xFF:  # fill byte
            out.append(0xFF)
            pos += 1
            continue
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
            out += data[pos : pos + 2]
            pos += 2
            continue
        if marker == 0xD9:  # EOI
            out += data[pos:]
            return bytes(out), removed, taken_at
        (length,) = struct.unpack(">H", data[pos + 2 : pos + 4])
        segment = data[pos : pos + 2 + length]
        payload = data[pos + 4 : pos + 2 + length]
        if marker == 0xDA:  # start of scan: the rest is entropy-coded data
            out += data[pos:]
            return bytes(out), removed, taken_at
        if marker == 0xE1 and payload.startswith(b"Exif\x00\x00"):
            exif = Image.Exif()
            try:
                exif.load(payload)
                taken_at = _taken_at(exif)
                has_gps = _EXIF_GPS_IFD in exif
            except Exception:  # noqa: BLE001 - unparseable EXIF: drop it entirely
                removed = True
                pos += 2 + length
                continue
            if has_gps:
                removed = True
                del exif[_EXIF_GPS_IFD]
                try:
                    new_payload = exif.tobytes()
                except Exception:  # noqa: BLE001
                    new_payload = b""
                if new_payload and len(new_payload) + 2 <= 0xFFFF:
                    if not new_payload.startswith(b"Exif\x00\x00"):
                        new_payload = b"Exif\x00\x00" + new_payload
                    out += b"\xff\xe1" + struct.pack(">H", len(new_payload) + 2) + new_payload
                # else: drop the EXIF segment; taken_at is still reported
            else:
                out += segment
            pos += 2 + length
            continue
        if marker == 0xE1 and (
            payload.startswith(b"http://ns.adobe.com/xap/1.0/") or payload.startswith(b"http://ns.adobe.com/xmp/extension/")
        ):
            # XMP can carry location (exif:GPSLatitude...). We never need it.
            if b"GPS" in payload or b"gps" in payload:
                removed = True
            pos += 2 + length
            continue
        out += segment
        pos += 2 + length
    out += data[pos:]
    return bytes(out), removed, taken_at


def _strip_other(data: bytes, media_type: str) -> tuple[bytes, str, bool, str | None]:
    with Image.open(io.BytesIO(data)) as img:
        exif = img.getexif()
        taken_at = _taken_at(exif) if exif else None
        has_meta = bool(exif) or any(k in img.info for k in ("exif", "xmp", "XML:com.adobe.xmp"))
        if not has_meta:
            return data, media_type, False, taken_at
        has_gps = _EXIF_GPS_IFD in exif if exif else False
        xmp = img.info.get("xmp") or img.info.get("XML:com.adobe.xmp") or b""
        if isinstance(xmp, str):
            xmp = xmp.encode("utf-8", "ignore")
        has_gps = has_gps or b"GPS" in xmp
        has_alpha = img.mode in ("RGBA", "LA", "PA") or "transparency" in img.info
        pixels = img.convert("RGBA" if has_alpha else "RGB")
        # A fresh image from raw pixels carries no metadata at all.
        clean = Image.frombytes(pixels.mode, pixels.size, pixels.tobytes())
        buf = io.BytesIO()
        clean.save(buf, format="PNG")
        return buf.getvalue(), "image/png", has_gps, taken_at


def sanitize(data: bytes, declared_type: str | None = None) -> SanitizedImage:
    """Validate an image and remove location metadata. Raises :class:`ImageError`."""
    if len(data) == 0:
        raise ImageError("empty", "That photo was empty. Please take it again.")
    if len(data) > Limits.max_file_bytes:
        mb = Limits.max_file_bytes // (1024 * 1024)
        raise ImageError("too_large", f"That photo is too big. Please send one under {mb} megabytes.", status=413)
    media_type = check_type(data, declared_type)
    try:
        if media_type == "image/jpeg":
            clean, removed, taken_at = _strip_jpeg(data)
        else:
            clean, media_type, removed, taken_at = _strip_other(data, media_type)
        with Image.open(io.BytesIO(clean)) as probe:
            w, h = probe.size
    except ImageError:
        raise
    except Image.DecompressionBombError as exc:
        raise ImageError("too_many_pixels", "That photo has too many pixels. Please send a smaller one.", 413) from exc
    except Exception as exc:  # noqa: BLE001
        raise ImageError("unreadable", "I couldn't open that photo. Please take it again.") from exc
    if w * h > Limits.max_pixels:
        raise ImageError("too_many_pixels", "That photo has too many pixels. Please send a smaller one.", 413)
    return SanitizedImage(
        data=clean,
        media_type=media_type,
        sha256=hashlib.sha256(clean).hexdigest(),
        gps_removed=removed,
        taken_at=taken_at,
    )


def decode(data: bytes, max_side: int) -> np.ndarray:
    """Decode to an RGB uint8 array no larger than ``max_side`` on its long edge.

    EXIF orientation is applied. Transparent areas are composited onto white (product cut-outs).
    """
    try:
        img = Image.open(io.BytesIO(data))
        if img.format == "JPEG":
            img.draft("RGB", (max_side, max_side))
        img = ImageOps.exif_transpose(img)
        if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
            rgba = img.convert("RGBA")
            background = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
            img = Image.alpha_composite(background, rgba)
        img = img.convert("RGB")
        if max(img.size) > max_side:
            img.thumbnail((max_side, max_side), Image.Resampling.BILINEAR)
        return np.asarray(img, dtype=np.uint8).copy()
    except Image.DecompressionBombError as exc:
        raise ImageError("too_many_pixels", "That photo has too many pixels. Please send a smaller one.", 413) from exc
    except ImageError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise ImageError("unreadable", "I couldn't open that photo. Please take it again.") from exc


def encode_jpeg(rgb: np.ndarray, quality: int = 90) -> bytes:
    """Encode pixels as a metadata-free JPEG (what we send to the vision model)."""
    buf = io.BytesIO()
    Image.fromarray(rgb).save(buf, format="JPEG", quality=quality)
    return buf.getvalue()
