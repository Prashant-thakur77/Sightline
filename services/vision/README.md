# services/vision

The unboxing check. It compares a delivered item with the listing it was bought from: colour, size
tag, whether it is the same product, and visible damage. It answers `match`, `mismatch` or `unsure`
with reasons in plain words. It never says `match` unless every check that applies agrees, and a
`mismatch` needs a reason it is sure of, backed by two independent looks (two looks before
"sure"). Anything else is `unsure`, with next steps and, when one would help, ONE extra photo to
take (`POST /recheck` then checks again with both photos).

Python 3.12, FastAPI, managed with uv. CPU only.

```sh
uv sync                                   # install (dev tools included)
uv run uvicorn app.main:app --port 8011   # serve
uv run pytest -q                          # tests (no network, no API key needed)
```

## API

### `GET /health`

```json
{"status": "ok", "version": "0.1.0", "vlm": {"configured": false, "engine": "none"},
 "ocr": {"engine": "rapidocr"}, "mask": "grabcut", "thresholds": "fitted-dev-2026-11-09"}
```

`vlm.configured` is false until `VISION_MODEL` and `ANTHROPIC_API_KEY` are both set. `thresholds`
is the version of the threshold set in use; every `/verify` response repeats it in
`modules.engines.thresholds`.

### `POST /quality`

Live framing hints, about one frame per second. Multipart field `image` (JPEG, PNG or WebP). The
frame is downscaled to 320 px; the check itself takes about 5 ms.

```json
{"code": "TOO_FAR", "guidance": "Move the phone closer.", "issues": ["TOO_FAR"],
 "metrics": {"mean_luma": 0.84, "p99_luma": 0.88, "sharpness": 2215.0, "glare_ratio": 0.0,
             "clip_low": 0.0, "clip_high": 0.0, "coverage": 0.03, "edge_touch": 0.0,
             "centre_vs_border": 73.8, "centre_item": 0.31, "fills_frame": 0.0},
 "elapsed_ms": 4.7}
```

| code | guidance |
|---|---|
| `TOO_DARK` | Too dark. Can you turn on a light? |
| `BLURRY` | Hold still for a moment. |
| `GLARE` | There's a glare. Tilt the phone a little. |
| `TOO_FAR` | Move the phone closer. |
| `TOO_CLOSE` | Move the phone back a little. |
| `OK` | Hold still, capturing. |

Codes are checked in that order. `code` is the first failing one; `issues` lists all of them. The
maths is simple on purpose (luma mean and 99th percentile, Laplacian variance over the item's
bounding box, clipped near-white pixels on the item, coverage against a smooth background model) so
the browser can run the same check on its own frames.

### `POST /verify`

Multipart form:

| field | type | notes |
|---|---|---|
| `item` | file, repeatable | Photo(s) of the delivered item. Required, at most 4. The sharpest photo that passes the quality gate is used for colour. |
| `label` | file | Close photo of the size tag. Without it the size is `unknown`. |
| `damage` | file | Optional close-up of possible damage. |
| `listing_images` | file, repeatable | Listing image(s), one part per image. `listing_image` is accepted too. These are the primary colour reference. |
| `listing_image_urls` | text, repeatable | Listing image URL(s). HTTPS only, public hosts only, redirects re-checked. `listing_image_url` is accepted too. At most 4 listing images in total. |
| `listing` | text (JSON) | `{"title", "colour", "size", "attributes"}`. `color` is accepted for `colour`. |

Response:

```json
{
  "verdict": {
    "kind": "mismatch",
    "reasons": [
      {"module": "size", "finding": "disagree", "confidence": "sure", "expected": "M", "observed": "L",
       "sentence": "The size tag reads L, you ordered M. I'm sure about that."},
      {"module": "colour", "finding": "disagree", "confidence": "fairly_sure", "expected": "navy",
       "observed": "black",
       "sentence": "The colour looks black, not navy, but the light is dim so I'm less sure."}
    ],
    "headline": "This doesn't match.",
    "next_steps": ["Keep the item, its tags and the packaging as they are.",
                   "I can help you ask the seller for your money back."]
  },
  "modules": {"photos": {}, "quality": {}, "mask": {}, "colour": {}, "size": {}, "identity": {},
              "damage": {}, "engines": {}},
  "timings_ms": {"decode": 23, "quality": 7, "mask": 270, "colour": 160, "size": 170,
                 "identity": 1, "damage": 1, "fusion": 0.1, "total": 630}
}
```

`verdict` has the shape of `Verdict` in `@sightline/core`. Field names are snake_case here; the only
one that differs is `next_steps`, which is `nextSteps` in TypeScript. `expected` and `observed` are
left out when unknown, never sent as `null`. Reasons are ordered for speaking: disagreements first
(most certain first), then unknowns, then agreements. Sentences use confidence words, never
percentages.

`modules` holds each module's raw output (delta E values, Lab colours, both tag reads, the model's
attribute comparison, mask method) for the evidence pack and for debugging. `modules.photos` lists
each photo's SHA-256, whether location data was removed, and the EXIF capture time.

Errors are `{"detail": {"code", "message"}}` with a message that is safe to read out:
`413 too_large | too_many_pixels`, `415 unsupported_type`, `422 bad_listing | no_item_photo |
too_many_photos | too_many_listing_images | bad_url | unreadable | empty`.

An `unsure` verdict also has `retake` (or `null`): `{kind: "tag" | "light" | "paper", module, why,
title, prompt}`, the one extra photo to ask for; `looks` (1, or 2 after it) and `signals` (independent
signals that the item differs).

### `POST /recheck`

The first check plus the ONE extra photo it asked for. Multipart form: `retake` (the photo),
`retake_kind` (`tag`, `light` or `paper`), `previous` (JSON: the first check's `modules`, as stored
by the caller), `listing` and `listing_images` as for `/verify`. Only the modules the photo can
inform run again; the answer has the same shape as `/verify`, with `looks: 2`, `retake: null` and the
second photo's own module outputs under `modules.second_look`. Errors as above, plus
`422 bad_previous | already_rechecked`.

## How the verdict is reached

1. **Quality gate** (`quality.py`) on each item photo. A poor photo can still produce a mismatch,
   but never a match.
2. **Item mask** (`mask.py`). GrabCut seeded by a centre rectangle and a background model; no
   model weights. The background is a quadratic Lab surface fitted to the image border with outlier
   rejection (`background.py`), so light falling off across a bed or table is not mistaken for the
   item. The same function masks the listing images. Optional rembg (u2netp): install with
   `uv sync --extra rembg` and set `VISION_MASK_METHOD=rembg`.
3. **Colour** (`colour.py`, `colour_names.py`). White balance from a white-paper reference when a
   sheet of paper is visible (`reference_used: true`): the region must be near-white and neutral
   (L* at least 75, low chroma), flat, compact, at most 60% of the background and clearly brighter than
   the rest of it, so a beige bed cover is never taken for paper. Otherwise gray world over the
   background only. Exposure is normalised only against paper, and never so far that the item clips.
   Mask pixels that still look like the background are dropped, masked pixels go sRGB -> linear ->
   XYZ (D65) -> CIELAB, and deterministic k-means (k=3) gives the dominant colour, passing over any
   cluster that looks like the background. It is compared with the listing images' dominant colour
   (primary) and with the listing colour name's Lab centre (secondary) using CIEDE2000, with lightness
   weighted down (kL = 2) because exposure moves lightness most. The CIEDE2000 code is checked
   against all 34 published CIEDE2000 reference test pairs. Colour abstains in a dark photo (the
   brightest 5% of the frame under 0.30 luma) or a strong colour cast; dim or tinted light, an
   unreliable mask and an item photo that fails the quality gate each lower confidence by one step.
   Without a white reference the exposure is unknown, so a `sure` disagreement also needs the
   colours to differ at the same brightness (delta E at least 10 after scaling the delivered colour
   to the listing colour's luminance): white read as grey is at most `fairly_sure`. If the listing
   photo and the colour name disagree with each other, colour abstains. `confidence_limits` in the
   module output says which of these lowered the confidence.
4. **Size label** (`label.py`). Read A: the vision model's structured read of the tag, with boxes.
   Read B: OCR (RapidOCR, PP-OCR models on ONNX Runtime, shipped inside the wheel, no download). OCR
   re-reads read A's size box when there is one. When the text detector finds no size (a lone thin
   "L" is easy to miss), it finds the label, binarises it, takes the tallest glyph blocks and runs
   recognition on each one alone, cleaned and upscaled. Only size tokens are accepted. Both reads are normalised (`Medium`, `MED`, `M`;
   `X-Large`, `XL`; `2XL`, `XXL`; `M/38`; `EU 40`). Two agreeing reads are `sure`; one read is at
   most `fairly_sure`; two different reads are `not_sure`. Letter and numeric sizes, or different
   numeric systems, are not compared.
5. **Identity** (`identity.py`) and **damage** (`damage.py`). Vision model checks with explicit
   attributes: neckline, sleeves, pattern, logo placement, closure, pockets, shape, material look;
   tears, stains, broken parts, missing pieces. A `sure` identity disagreement needs a named
   attribute difference or a different product type. Clearly visible damage is `sure`; possible
   damage asks for a close-up.
   **Quote-or-unsure** (`citation.py`, checked in code, not by trusting the model): each identity
   attribute names where on the delivered item it is visible (`item_region`) and what is there
   (`item`); the product type cites the part that shows it (`item_type_evidence`); each damage
   finding names the spot (`where`) and what is visible there (`sees`). A citation counts only when
   the region contains a place word (sleeve, collar, hem, handle, sole, left, top...) and the
   description is not a hedge ("not visible", "too dark to see"); damage described together with a
   harmless explanation ("a stain, or just shadow") does not count. An identity read without a
   cited difference (or, for a match, without a cited attribute) is `unknown` (`no_citation`);
   uncited damage counts as `cannot_tell`. `vlm.PROMPT_VERSION` names the prompt and schema version.
6. **Fusion** (`fusion.py`). `mismatch` needs a `sure` disagreement **and two independent signals
   that agree** (two looks before "sure"). A signal is one module disagreeing about one photo at
   `fairly_sure` or better: a `sure` size already rests on two reads (model and OCR) of the tag;
   two modules that disagree (colour and identity, say) are two signals; one module that saw the
   difference on two photos is two. A `sure` disagreement with one signal is said as "only fairly
   sure from one photo" and the verdict is `unsure`. `match` needs colour, size and identity (each
   where the listing gives something to compare) to agree at the minimum confidence in
   `thresholds.json`, no disagreement anywhere, and a usable photo. Otherwise `unsure`.
7. **One extra photo** (`fusion.choose_retake`, `looks.py`). An `unsure` verdict carries `retake`:
   the one shot most likely to settle it, chosen from why it was not sure. A difference seen once
   comes first; otherwise the shot that re-checks the most of what kept it from a match. `tag` (a
   close photo of the size tag) re-reads the size; `light` (the whole item near a window or under a
   bright light) re-runs colour, identity and damage; `paper` (white paper next to the item)
   re-runs colour, for tinted light. `POST /recheck` combines each re-run module with its first
   look: two disagreeing looks are two signals; a disagreeing and an agreeing look are `unknown`
   ("the two photos don't agree"); otherwise the clearer look counts. No further photo is asked
   for after that.

Without a model key, identity and damage report `unknown`, so the service answers `unsure` or
`mismatch`, never `match`.

## Thresholds

Every decision threshold is in `app/thresholds.json`, version `fitted-dev-2026-11-09`: the hand-set
starting values with the colour confidence rules fitted on the SightBench dev split only (synthetic
renders, 180 pairs), never on test. Its `fitted` block records what changed and the dev evidence:

| key | hand-set | fitted | why (dev split) |
|---|---|---|---|
| `colour.quality_issue_steps` | 0 | 1 | All 5 `sure` colour disagreements on right-colour items came from photos that failed the quality gate. |
| `colour.sure_min_de_same_brightness` | off | 10 | Without a white reference, brightness alone (white read as grey, blush as brown) must not make the check sure. |
| `colour.poor_bright_luma` | 0.15 | 0.30 | Below it, colour disagreements carried no information (23 of 34 right-colour items "disagreed", 3 of 6 wrong-colour ones). |

Everything else keeps its hand-set value. The hand-set set is kept as
`app/threshold_sets/initial-unfitted.json` (the first SightBench test run used it); the two keys
added later are set there to values that reproduce its original behaviour.

`VISION_THRESHOLDS` takes a set name (`initial-unfitted`), which replaces the default, or a path to
an override file, which is overlaid on the default and only needs the keys it changes. Fit on the
SightBench dev split only, never on test.

## Privacy

Every image, uploaded or fetched by URL, goes through `imageio.sanitize` before anything reads it:
the EXIF GPS directory and XMP packets are removed (JPEGs are rewritten segment by segment, so pixels
are not re-encoded; other formats with metadata are re-encoded losslessly as PNG). The capture time
is kept. Images sent to the vision model are re-encoded from decoded pixels and carry no metadata.
The service stores nothing.

## Configuration

| variable | default | meaning |
|---|---|---|
| `VISION_MODEL` | unset | Model id for the vision model. Unset: model checks report `unknown`. |
| `ANTHROPIC_API_KEY` | unset | API key for the model. |
| `VISION_EFFORT` | `low` | `output_config.effort` sent with each model call. Empty to omit. |
| `VISION_FALLBACKS` | `default` | Server-side fallback on a declined request. `off` to disable. |
| `VISION_MASK_METHOD` | `grabcut` | `rembg` to use the optional neural mask. |
| `VISION_OCR` | `rapidocr` | `off` to disable OCR (size then gets a single read). |
| `VISION_OCR_THREADS` | ONNX default | Threads for OCR inference (the Docker image sets 2). |
| `VISION_WARM_OCR` | `1` | Load the OCR models in the background at startup. |
| `VISION_THRESHOLDS` | unset | A threshold set name (`initial-unfitted`) or a path to an override file. |
| `VISION_MAX_FILE_MB` / `VISION_MAX_REQUEST_MB` | `10` / `40` | Upload limits. |

## Footprint

Measured with uvicorn, one worker, no model key: about 155 MB resident after startup with OCR
loaded, about 320 MB peak while serving `/verify` with a 1600x1200 item photo. The model SDK adds
about 45 MB once a key is set. `/verify` without model calls takes about 0.6 s of CPU; `/quality`
about 5 ms plus decoding.

## Docker

```sh
docker build -t sightline-vision services/vision
docker run --rm -p 8011:8011 --env-file .env.local sightline-vision
```

`python:3.12-slim`, non-root user, port 8011 (or `$PORT`), `uvicorn app.main:app`.

## Benchmark

```sh
uv run python -m app.bench --manifest evals/sightbench/dev.json --out evals/results/sightbench-dev.json
```

Runs the `/verify` logic over a manifest of pairs and writes JSON: mismatch recall, false-alarm
rate, match rate, abstention rate and accuracy when not abstaining, each overall, per mismatch type
and per lighting condition, with Wilson 95% intervals, plus p50/p95 latency, git SHA and thresholds
version. `--no-vlm` runs without the model, `--disable colour,size` switches modules off for
ablations, `--thresholds` tries an override file. The manifest format is documented at the top of
`app/bench.py`.

`python -m app.looks_bench` scores two looks, quote-or-unsure reads and one simulated extra photo on
SightBench (see `evals/sightbench/README.md`, "Two looks, quoted reads, one extra photo"). It caches
every new model read by prompt version and keeps a spend ledger with a hard cap.

## Not done yet

- The model client has only been exercised against a stubbed SDK. With a key: run the bench on the
  dev split, check the label, identity and damage prompts on real photos, and confirm the request
  options (`effort`, `fallbacks`) suit the chosen `VISION_MODEL`.
- Only the colour confidence rules are fitted, and only on synthetic dev renders. Colour name
  tolerances, the agree cut-offs, the quality-gate and mask limits and the label values are still
  hand-set, and everything needs refitting on real dev photos.
- On wood tables and plank floors the colour check gives up: gray-world white balance reads the
  orange surface as orange light. The masks there are fine; it needs a white reference (a sheet of
  paper) in the photo or a better light estimate.
- The quality gate's coverage estimate assumes a plain surface. Patterned or very dark surfaces will
  give wrong framing hints.
- HEIC uploads are not accepted; the browser should send JPEG.
