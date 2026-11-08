from __future__ import annotations

import io

import numpy as np
import pytest
from PIL import Image

from app import imageio
from app.config import Limits
from app.imageio import ImageError, decode, sanitize

from synth import NAVY, exif_with_gps, render_scene, to_jpeg


@pytest.fixture(scope="module")
def rgb():
    return render_scene(NAVY, h=240, w=320)[0]


def _gps(data: bytes) -> dict:
    with Image.open(io.BytesIO(data)) as img:
        return dict(img.getexif().get_ifd(0x8825))


def test_jpeg_gps_is_removed_and_pixels_untouched(rgb):
    original = to_jpeg(rgb, exif=exif_with_gps())
    assert _gps(original)  # the fixture really carries a location
    clean = sanitize(original, "image/jpeg")
    assert clean.gps_removed is True
    assert _gps(clean.data) == {}
    assert b"GPS" not in clean.data or _gps(clean.data) == {}
    with Image.open(io.BytesIO(clean.data)) as img:
        assert img.getexif().get(0x010F) == "PhoneMaker"  # other EXIF kept
    assert clean.taken_at == "2026:11:01 10:15:00"
    # The image data itself is copied byte for byte, so decoding gives identical pixels.
    np.testing.assert_array_equal(decode(original, 4096), decode(clean.data, 4096))
    assert len(clean.sha256) == 64


def test_jpeg_without_gps_is_unchanged(rgb):
    original = to_jpeg(rgb)
    clean = sanitize(original)
    assert clean.gps_removed is False
    assert clean.data == original


def test_xmp_packets_are_dropped(rgb):
    original = to_jpeg(rgb)
    xmp = b"http://ns.adobe.com/xap/1.0/\x00<x:xmpmeta><exif:GPSLatitude>12,58N</exif:GPSLatitude></x:xmpmeta>"
    segment = b"\xff\xe1" + (len(xmp) + 2).to_bytes(2, "big") + xmp
    with_xmp = original[:2] + segment + original[2:]
    clean = sanitize(with_xmp)
    assert clean.gps_removed is True
    assert b"GPSLatitude" not in clean.data


def test_png_with_gps_is_re_encoded_without_metadata(rgb):
    buf = io.BytesIO()
    Image.fromarray(rgb).save(buf, format="PNG", exif=exif_with_gps())
    clean = sanitize(buf.getvalue(), "image/png")
    assert clean.gps_removed is True
    assert clean.media_type == "image/png"
    assert _gps(clean.data) == {}
    np.testing.assert_array_equal(decode(clean.data, 4096), rgb)


@pytest.mark.parametrize(
    "data,declared",
    [
        (b"GIF89a" + b"\x00" * 100, "image/gif"),
        (b"%PDF-1.7 hello", "application/pdf"),
        (b"not an image at all", None),
    ],
)
def test_non_images_are_rejected(data, declared):
    with pytest.raises(ImageError) as err:
        sanitize(data, declared)
    assert err.value.status == 415
    assert err.value.code == "unsupported_type"


def test_declared_type_must_be_an_image(rgb):
    with pytest.raises(ImageError) as err:
        sanitize(to_jpeg(rgb), "text/html")
    assert err.value.status == 415


def test_generic_and_jpg_declared_types_are_accepted(rgb):
    assert sanitize(to_jpeg(rgb), "application/octet-stream").media_type == "image/jpeg"
    assert sanitize(to_jpeg(rgb), "image/jpg").media_type == "image/jpeg"


def test_oversized_files_are_rejected(monkeypatch, rgb):
    monkeypatch.setattr(Limits, "max_file_bytes", 1000)
    with pytest.raises(ImageError) as err:
        sanitize(to_jpeg(rgb))
    assert err.value.status == 413


def test_too_many_pixels_are_rejected(monkeypatch, rgb):
    monkeypatch.setattr(Limits, "max_pixels", 1000)
    with pytest.raises(ImageError) as err:
        sanitize(to_jpeg(rgb))
    assert err.value.code == "too_many_pixels"


def test_truncated_image_is_unreadable(rgb):
    data = to_jpeg(rgb)[:200]
    with pytest.raises(ImageError):
        decode(sanitize(data).data, 512)


def test_decode_applies_orientation_and_downscales():
    tall = np.zeros((200, 100, 3), np.uint8)
    tall[:20] = 255  # bright band at the top
    exif = Image.Exif()
    exif[0x0112] = 6  # rotate 90 degrees clockwise when displayed
    buf = io.BytesIO()
    Image.fromarray(tall).save(buf, format="JPEG", exif=exif, quality=95)
    out = decode(buf.getvalue(), 64)
    assert out.shape[1] > out.shape[0]  # displayed landscape
    assert max(out.shape[:2]) == 64


def test_transparent_listing_images_are_put_on_white():
    rgba = np.zeros((50, 50, 4), np.uint8)
    rgba[10:40, 10:40] = (30, 42, 78, 255)
    buf = io.BytesIO()
    Image.fromarray(rgba, "RGBA").save(buf, format="PNG")
    out = decode(sanitize(buf.getvalue()).data, 512)
    assert tuple(out[0, 0]) == (255, 255, 255)
    assert tuple(out[25, 25]) == (30, 42, 78)


def test_vlm_jpeg_has_no_metadata(rgb):
    data = imageio.encode_jpeg(rgb)
    with Image.open(io.BytesIO(data)) as img:
        assert len(img.getexif()) == 0
