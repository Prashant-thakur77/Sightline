from __future__ import annotations

import io
import json

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image
from starlette.applications import Starlette
from starlette.responses import PlainTextResponse
from starlette.routing import Route

from app import main, pipeline
from app.config import Limits, load_thresholds
from app.imageio import ImageError

from fakes import FakeVlm, damage_answer, label_answer
from synth import BLACK, NAVY, exif_with_gps, listing_image, render_scene, render_tag, to_jpeg, to_png

LISTING = {"title": "Harbor knit crew-neck sweater", "colour": "Navy", "size": "M", "attributes": {"type": "sweater"}}


@pytest.fixture(scope="module")
def client():
    with TestClient(main.app) as c:
        yield c


@pytest.fixture
def fake_engines(monkeypatch, ocr_engine):
    vlm = FakeVlm()
    monkeypatch.setattr(pipeline, "get_vlm_client", lambda: vlm)
    monkeypatch.setattr(pipeline, "get_ocr_engine", lambda: ocr_engine)
    return vlm


@pytest.fixture(scope="module")
def photos():
    return {
        "navy": to_jpeg(render_scene(NAVY)[0], exif=exif_with_gps()),
        "black": to_jpeg(render_scene(BLACK)[0]),
        "tag_m": to_png(render_tag(["HARBOR", "M", "100% COTTON"], [34, 150, 26])),
        "tag_l": to_png(render_tag(["HARBOR", "L", "100% COTTON"], [34, 150, 26])),
        "listing": to_jpeg(listing_image(NAVY)),
    }


def _files(photos, item="navy", tag="tag_m", listing_files=1, damage=False):
    files = [("item", ("item.jpg", photos[item], "image/jpeg")), ("label", ("tag.png", photos[tag], "image/png"))]
    files += [("listing_image", (f"l{i}.jpg", photos["listing"], "image/jpeg")) for i in range(listing_files)]
    if damage:
        files.append(("damage", ("d.jpg", photos[item], "image/jpeg")))
    return files


def test_health(client):
    body = client.get("/health").json()
    assert body["status"] == "ok"
    assert body["vlm"] == {"configured": False, "engine": "none"}
    assert body["ocr"]["engine"] in ("rapidocr", "none")
    assert body["thresholds"] == load_thresholds()["version"]


def test_quality_endpoint_returns_a_hint(client):
    r = client.post("/quality", files={"image": ("f.jpg", to_jpeg(render_scene(NAVY)[0]), "image/jpeg")})
    assert r.status_code == 200
    body = r.json()
    assert body["code"] == "OK"
    assert body["guidance"] == "Hold still, capturing."
    r = client.post("/quality", files={"image": ("f.jpg", to_jpeg(render_scene(NAVY, scale=0.35)[0]), "image/jpeg")})
    assert r.json()["code"] == "TOO_FAR"
    assert r.json()["guidance"] == "Move the phone closer."


def test_quality_rejects_non_images(client):
    r = client.post("/quality", files={"image": ("f.txt", b"hello there", "text/plain")})
    assert r.status_code == 415
    assert r.json()["detail"]["code"] == "unsupported_type"


def test_verify_match(client, fake_engines, photos):
    r = client.post("/verify", files=_files(photos), data={"listing": json.dumps(LISTING)})
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) == {"verdict", "modules", "timings_ms"}
    v = body["verdict"]
    assert v["kind"] == "match"
    assert v["headline"] == "This matches: navy, size M, the same sweater."
    for key in ("colour", "size", "identity", "damage", "quality", "photos", "mask"):
        assert key in body["modules"]
    for key in ("decode", "quality", "mask", "colour", "size", "identity", "damage", "fusion", "total"):
        assert key in body["timings_ms"]
    # Every response names the threshold set it was judged with, and colour sees the quality gate.
    assert body["modules"]["engines"]["thresholds"] == load_thresholds()["version"]
    assert body["modules"]["colour"]["photo_ok"] is (body["modules"]["quality"]["code"] == "OK")
    # Location stripped before processing; the capture time is kept.
    item_meta = body["modules"]["photos"]["item"][0]
    assert item_meta["gps_removed"] is True
    assert item_meta["taken_at"] == "2026:11:01 10:15:00"


def test_verify_wrong_size_and_colour_is_a_mismatch(client, fake_engines, photos):
    fake_engines.label = label_answer("L")
    r = client.post("/verify", files=_files(photos, item="black", tag="tag_l"), data={"listing": json.dumps(LISTING)})
    v = r.json()["verdict"]
    assert v["kind"] == "mismatch"
    assert v["reasons"][0]["sentence"] == "The size tag reads L, you ordered M. I'm sure about that."
    colour = next(x for x in v["reasons"] if x["module"] == "colour")
    assert colour["finding"] == "disagree"
    assert colour["observed"] == "black"


def test_verify_damage_photo_goes_to_the_model(client, fake_engines, photos):
    # A tear seen on one look is "not sure" with one more photo asked for (two looks before "sure").
    fake_engines.damage = damage_answer(tears=("clearly", "left sleeve"))
    r = client.post("/verify", files=_files(photos, damage=True), data={"listing": json.dumps(LISTING)})
    v = r.json()["verdict"]
    assert v["kind"] == "unsure"
    assert v["retake"]["kind"] == "light"
    assert ("damage", 2) in fake_engines.calls  # damage close-up + item photo


def test_verify_without_a_model_is_never_a_match(client, monkeypatch, ocr_engine, photos):
    monkeypatch.setattr(pipeline, "get_ocr_engine", lambda: ocr_engine)
    r = client.post("/verify", files=_files(photos), data={"listing": json.dumps(LISTING)})
    body = r.json()
    assert body["verdict"]["kind"] == "unsure"
    assert body["modules"]["engines"]["vlm"] == "none"


def test_verify_accepts_color_spelling(client, fake_engines, photos):
    listing = {"title": "Sweater", "color": "Navy", "size": "M"}
    r = client.post("/verify", files=_files(photos), data={"listing": json.dumps(listing)})
    assert r.json()["modules"]["colour"]["expected_name"] == "navy"


@pytest.mark.parametrize(
    "files,listing,status,code",
    [
        ("no_item", LISTING, 422, None),
        ("ok", "not json", 422, "bad_listing"),
        ("five_items", LISTING, 422, "too_many_photos"),
        ("bad_type", LISTING, 415, "unsupported_type"),
        ("too_many_listing", LISTING, 422, "too_many_listing_images"),
    ],
)
def test_verify_rejects_bad_requests(client, fake_engines, photos, files, listing, status, code):
    sets = {
        "no_item": [("label", ("tag.png", photos["tag_m"], "image/png"))],
        "ok": _files(photos),
        "five_items": [("item", (f"{i}.jpg", photos["navy"], "image/jpeg")) for i in range(5)],
        "bad_type": [("item", ("x.gif", b"GIF89a....", "image/gif"))],
        "too_many_listing": _files(photos, listing_files=5),
    }
    data = {"listing": listing if isinstance(listing, str) else json.dumps(listing)}
    r = client.post("/verify", files=sets[files], data=data)
    assert r.status_code == status, r.text
    if code:
        assert r.json()["detail"]["code"] == code


def test_verify_rejects_oversized_files(client, fake_engines, photos, monkeypatch):
    monkeypatch.setattr(Limits, "max_file_bytes", 2000)
    r = client.post("/verify", files=_files(photos), data={"listing": json.dumps(LISTING)})
    assert r.status_code == 413
    assert r.json()["detail"]["code"] == "too_large"


@pytest.mark.parametrize("url", ["http://example.com/a.jpg", "https://127.0.0.1/a.jpg", "https://10.0.0.5/a.jpg", "file:///etc/passwd"])
def test_listing_urls_must_be_public_https(client, fake_engines, photos, url):
    files = _files(photos, listing_files=0)
    r = client.post("/verify", files=files, data={"listing": json.dumps(LISTING), "listing_image_url": url})
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "bad_url"


def test_body_limit_middleware():
    async def echo(request):
        return PlainTextResponse(str(len(await request.body())))

    small = main.BodyLimit(Starlette(routes=[Route("/", echo, methods=["POST"])]), max_bytes=100)
    with TestClient(small) as c:
        assert c.post("/", content=b"x" * 50).text == "50"
        r = c.post("/", content=b"x" * 500)
        assert r.status_code == 413


async def _fetch(handler, url, monkeypatch):
    monkeypatch.setattr(main, "_public_ip", lambda host: host != "internal.example")
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        return await main.fetch_listing_image(client, url)


def test_fetch_listing_image_strips_gps(monkeypatch):
    import asyncio

    jpeg = to_jpeg(listing_image(NAVY, size=200), exif=exif_with_gps())

    def handler(request):
        return httpx.Response(200, content=jpeg, headers={"content-type": "image/jpeg"})

    img = asyncio.run(_fetch(handler, "https://cdn.example/p.jpg", monkeypatch))
    assert img.gps_removed is True
    with Image.open(io.BytesIO(img.data)) as probe:
        assert dict(probe.getexif().get_ifd(0x8825)) == {}


@pytest.mark.parametrize("location", ["https://internal.example/x.jpg", "http://cdn.example/x.jpg"])
def test_fetch_listing_image_rechecks_redirects(monkeypatch, location):
    import asyncio

    def handler(request):
        return httpx.Response(302, headers={"location": location})

    with pytest.raises(ImageError) as err:
        asyncio.run(_fetch(handler, "https://cdn.example/p.jpg", monkeypatch))
    assert err.value.code == "bad_url"


def test_openapi_documents_the_endpoints(client):
    spec = client.get("/openapi.json").json()
    assert {"/health", "/quality", "/verify", "/recheck"} <= set(spec["paths"])
