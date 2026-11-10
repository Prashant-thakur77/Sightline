"""HTTP API for the unboxing check.

GET  /health   service status and which engines are configured
POST /quality  one camera frame -> framing hint (for ~1 fps live guidance)
POST /verify   item photo(s), size tag, optional damage photo and the listing -> verdict
POST /recheck  the first check's modules plus ONE extra photo it asked for -> verdict from both looks
"""

from __future__ import annotations

import asyncio
import ipaddress
import json
import logging
import os
import socket
import threading
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated, Any, Literal
from urllib.parse import urlsplit

import httpx
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import AliasChoices, BaseModel, ConfigDict, Field, ValidationError
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from . import __version__, quality
from .config import Limits, thresholds
from .imageio import ImageError, SanitizedImage, decode, sanitize
from .label import RapidOcrEngine, get_ocr_engine
from .mask import item_mask  # noqa: F401  (imported so a broken OpenCV install fails at boot)
from .pipeline import VerifyInputs, run_second_look, run_verify
from .vlm import get_vlm_client

log = logging.getLogger("vision")


# --------------------------------------------------------------------------------------------
# Models (request validation and OpenAPI documentation)
# --------------------------------------------------------------------------------------------


class Listing(BaseModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    title: str | None = Field(default=None, max_length=500)
    colour: str | None = Field(default=None, max_length=80, validation_alias=AliasChoices("colour", "color"))
    size: str | None = Field(default=None, max_length=40)
    attributes: dict[str, str] | None = Field(default=None, max_length=40)


class ReasonOut(BaseModel):
    module: Literal["colour", "size", "identity", "damage", "quality"]
    finding: Literal["agree", "disagree", "unknown"]
    confidence: Literal["sure", "fairly_sure", "not_sure"]
    expected: str | None = None
    observed: str | None = None
    sentence: str


class RetakeOut(BaseModel):
    kind: Literal["tag", "light", "paper"]
    module: str
    why: str
    title: str
    prompt: str


class VerdictOut(BaseModel):
    kind: Literal["match", "mismatch", "unsure"]
    reasons: list[ReasonOut]
    headline: str
    next_steps: list[str]
    retake: RetakeOut | None = Field(default=None, description="The one extra photo that would help, when the check is not sure.")
    looks: int = Field(default=1, description="Photos of the item behind this verdict: 1, or 2 after a retake.")
    signals: int = Field(default=0, description="Independent signals that the item differs.")


class VerifyOut(BaseModel):
    verdict: VerdictOut
    modules: dict[str, Any]
    timings_ms: dict[str, float]


class QualityOut(BaseModel):
    code: Literal["TOO_DARK", "BLURRY", "GLARE", "TOO_FAR", "TOO_CLOSE", "OK"]
    guidance: str
    issues: list[str]
    metrics: dict[str, float]
    elapsed_ms: float


class ErrorOut(BaseModel):
    detail: dict[str, str]


# --------------------------------------------------------------------------------------------
# App
# --------------------------------------------------------------------------------------------


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    thresholds()  # fail fast on a broken thresholds file
    ocr = get_ocr_engine()
    if isinstance(ocr, RapidOcrEngine) and os.environ.get("VISION_WARM_OCR", "1") != "0":
        threading.Thread(target=ocr.warm_up, name="ocr-warmup", daemon=True).start()
    yield


class BodyLimit:
    """Reject request bodies over the limit before they are parsed (413)."""

    def __init__(self, app: ASGIApp, max_bytes: int) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        for name, value in scope.get("headers", []):
            if name == b"content-length" and value.isdigit() and int(value) > self.max_bytes:
                await _too_large(send)
                return
        seen = 0

        async def limited() -> Message:
            nonlocal seen
            message = await receive()
            if message["type"] == "http.request":
                seen += len(message.get("body", b""))
                if seen > self.max_bytes:
                    raise HTTPException(413, detail=_detail("too_large", "Those photos are too big together."))
            return message

        await self.app(scope, limited, send)


async def _too_large(send: Send) -> None:
    body = json.dumps({"detail": _detail("too_large", "Those photos are too big together. Please send fewer or smaller photos.")}).encode()
    await send({"type": "http.response.start", "status": 413, "headers": [(b"content-type", b"application/json")]})
    await send({"type": "http.response.body", "body": body})


def _detail(code: str, message: str) -> dict[str, str]:
    return {"code": code, "message": message}


app = FastAPI(
    title="Unboxing check",
    version=__version__,
    summary="Checks a delivered item against the listing it was bought from.",
    lifespan=lifespan,
)
app.add_middleware(BodyLimit, max_bytes=Limits.max_request_bytes)


@app.exception_handler(ImageError)
async def _image_error(_: Any, exc: ImageError) -> JSONResponse:
    return JSONResponse(status_code=exc.status, content={"detail": _detail(exc.code, exc.message)})


@app.get("/health")
def health() -> dict[str, Any]:
    vlm = get_vlm_client()
    ocr = get_ocr_engine()
    return {
        "status": "ok",
        "version": __version__,
        "vlm": {"configured": bool(vlm.available), "engine": vlm.name},
        "ocr": {"engine": ocr.name},
        "mask": os.environ.get("VISION_MASK_METHOD", "grabcut"),
        "thresholds": thresholds().get("version"),
    }


def _read_upload(upload: UploadFile) -> SanitizedImage:
    data = upload.file.read(Limits.max_file_bytes + 1)
    return sanitize(data, upload.content_type)


@app.post("/quality", response_model=QualityOut, responses={413: {"model": ErrorOut}, 415: {"model": ErrorOut}, 422: {"model": ErrorOut}})
def quality_check(image: Annotated[UploadFile, File(description="One camera frame (JPEG, PNG or WebP).")]) -> dict[str, Any]:
    """Framing hint for one frame. Frames are downscaled to 320 px; typical cost is a few ms."""
    clean = _read_upload(image)
    rgb = decode(clean.data, Limits.quality_max_side)
    return quality.assess(rgb).to_dict()


# --------------------------------------------------------------------------------------------
# Listing images by URL
# --------------------------------------------------------------------------------------------


def _public_ip(host: str) -> bool:
    try:
        infos = socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP)
    except socket.gaierror:
        return False
    if not infos:
        return False
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if not ip.is_global or ip.is_multicast:
            return False
    return True


async def fetch_listing_image(client: httpx.AsyncClient, url: str) -> SanitizedImage:
    """Fetch a listing image over HTTPS from a public host, re-checking each redirect."""
    bad = ImageError("bad_url", "I couldn't load a listing photo from that link.", status=422)
    current = url
    for _ in range(4):
        parts = urlsplit(current)
        if parts.scheme != "https" or not parts.hostname:
            raise bad
        if not await asyncio.to_thread(_public_ip, parts.hostname):
            raise bad
        try:
            async with client.stream("GET", current, follow_redirects=False) as resp:
                if resp.is_redirect and resp.headers.get("location"):
                    current = str(resp.url.join(resp.headers["location"]))
                    continue
                if resp.status_code != 200:
                    raise bad
                buf = bytearray()
                async for chunk in resp.aiter_bytes():
                    buf += chunk
                    if len(buf) > Limits.max_file_bytes:
                        raise ImageError("too_large", "A listing photo was too big to load.", status=413)
                return sanitize(bytes(buf), resp.headers.get("content-type"))
        except httpx.HTTPError as exc:
            raise bad from exc
    raise bad


# --------------------------------------------------------------------------------------------
# Verify
# --------------------------------------------------------------------------------------------


@app.post(
    "/verify",
    response_model=VerifyOut,
    responses={413: {"model": ErrorOut}, 415: {"model": ErrorOut}, 422: {"model": ErrorOut}},
)
async def verify(
    item: Annotated[list[UploadFile], File(description="Photo(s) of the delivered item, up to 4.")],
    listing: Annotated[str, Form(description='JSON: {"title", "colour", "size", "attributes"}.')],
    label: Annotated[UploadFile | None, File(description="Close photo of the size tag.")] = None,
    damage: Annotated[UploadFile | None, File(description="Optional close photo of possible damage.")] = None,
    listing_images: Annotated[list[UploadFile] | None, File(description="Listing image file(s); repeat the part for each.")] = None,
    listing_image: Annotated[list[UploadFile] | None, File(description="Same as listing_images (singular spelling).")] = None,
    listing_image_urls: Annotated[list[str] | None, Form(description="Listing image URL(s), https only; repeatable.")] = None,
    listing_image_url: Annotated[list[str] | None, Form(description="Same as listing_image_urls (singular spelling).")] = None,
) -> JSONResponse:
    """Check the delivered item against the listing.

    Location data is stripped from every photo before anything else reads it. The response has the
    verdict (``kind``, ``reasons``, ``headline``, ``next_steps``), each module's raw output and the
    time each step took.
    """
    try:
        listing_obj = Listing.model_validate(json.loads(listing))
    except (json.JSONDecodeError, ValidationError, TypeError) as exc:
        raise HTTPException(422, detail=_detail("bad_listing", "The listing details were not readable.")) from exc

    items = [u for u in item if u.filename or u.size]
    if not items:
        raise HTTPException(422, detail=_detail("no_item_photo", "Please add a photo of the item."))
    if len(items) > Limits.max_item_photos:
        raise HTTPException(422, detail=_detail("too_many_photos", f"Please send at most {Limits.max_item_photos} photos of the item."))
    files = [u for u in [*(listing_images or []), *(listing_image or [])] if u.filename or u.size]
    urls = [u.strip() for u in [*(listing_image_urls or []), *(listing_image_url or [])] if u and u.strip()]
    if len(urls) > Limits.max_listing_urls or len(files) + len(urls) > Limits.max_listing_images:
        raise HTTPException(
            422, detail=_detail("too_many_listing_images", f"Please send at most {Limits.max_listing_images} listing photos.")
        )

    item_clean = [await run_in_threadpool(_read_upload, u) for u in items]
    label_clean = await run_in_threadpool(_read_upload, label) if label is not None else None
    damage_clean = await run_in_threadpool(_read_upload, damage) if damage is not None else None
    listing_clean = [await run_in_threadpool(_read_upload, u) for u in files]
    if urls:
        async with httpx.AsyncClient(timeout=Limits.url_timeout_s, headers={"user-agent": "unboxing-check/0.1"}) as client:
            listing_clean += await asyncio.gather(*(fetch_listing_image(client, u) for u in urls))

    inputs = VerifyInputs(
        item_photos=item_clean,
        label_photo=label_clean,
        damage_photo=damage_clean,
        listing_images=listing_clean,
        listing=listing_obj.model_dump(),
    )
    result = await run_in_threadpool(run_verify, inputs)
    return JSONResponse(result)


# --------------------------------------------------------------------------------------------
# Recheck: the first check plus ONE extra photo
# --------------------------------------------------------------------------------------------

_PREVIOUS_MODULES = ("quality", "colour", "size", "identity", "damage")


def _previous_modules(raw: str) -> dict[str, Any]:
    bad = HTTPException(422, detail=_detail("bad_previous", "The first check's results were not readable."))
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise bad from exc
    if not isinstance(data, dict) or not any(isinstance(data.get(k), dict) for k in _PREVIOUS_MODULES):
        raise bad
    if int(data.get("looks") or 1) >= 2:
        raise HTTPException(422, detail=_detail("already_rechecked", "This check already has its extra photo."))
    return {k: data[k] for k in _PREVIOUS_MODULES if isinstance(data.get(k), dict)}


@app.post(
    "/recheck",
    response_model=VerifyOut,
    responses={413: {"model": ErrorOut}, 415: {"model": ErrorOut}, 422: {"model": ErrorOut}},
)
async def recheck(
    retake: Annotated[UploadFile, File(description="The one extra photo the first check asked for.")],
    retake_kind: Annotated[Literal["tag", "light", "paper"], Form(description="Which extra photo it is: tag, light or paper.")],
    previous: Annotated[str, Form(description="JSON: the first check's `modules` (from /verify), as stored by the caller.")],
    listing: Annotated[str, Form(description='JSON: {"title", "colour", "size", "attributes"}.')],
    listing_images: Annotated[list[UploadFile] | None, File(description="Listing image file(s); repeat the part for each.")] = None,
) -> JSONResponse:
    """Check again with both looks: the first check's module outputs and one extra photo.

    Only the modules the extra photo can inform run again (size for a tag photo; colour, identity
    and damage for a photo in better light; colour for a photo next to white paper). A "sure"
    mismatch still needs two signals that agree, which the two photos can now give. No further
    extra photo is asked for after this.
    """
    try:
        listing_obj = Listing.model_validate(json.loads(listing))
    except (json.JSONDecodeError, ValidationError, TypeError) as exc:
        raise HTTPException(422, detail=_detail("bad_listing", "The listing details were not readable.")) from exc
    previous_modules = _previous_modules(previous)
    files = [u for u in (listing_images or []) if u.filename or u.size]
    if len(files) > Limits.max_listing_images:
        raise HTTPException(
            422, detail=_detail("too_many_listing_images", f"Please send at most {Limits.max_listing_images} listing photos.")
        )
    retake_clean = await run_in_threadpool(_read_upload, retake)
    listing_clean = [await run_in_threadpool(_read_upload, u) for u in files]
    result = await run_in_threadpool(run_second_look, previous_modules, retake_kind, retake_clean, listing_clean, listing_obj.model_dump())
    return JSONResponse(result)
