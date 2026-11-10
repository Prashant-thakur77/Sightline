# SightBench: does the parcel match?

SightBench measures the unboxing check (`services/vision`, `POST /verify`): given the listing a
buyer paid for and photos of what arrived, does the service say `match`, `mismatch` or `unsure`,
and is it right? Results go to `evals/results/sightbench.json` and `evals/RESULTS.md`.

**Everything in the current set is synthetic.** Listing images are clean product renders and the
"delivered" photos are phone-like renders. No real photo is in it yet (see "Adding real photos").

## Method

### Data (synthetic-hybrid, seeded)

`py/sightbench/` renders everything from seed `20261109`:

- **Catalogue**: 60 fictional products (16 sweaters, 14 T-shirts, 8 hoodies, 10 mugs, 12 shoes),
  each a distinct combination of visible features (neckline, knit, pocket, trim, print, hood, zip,
  mug shape, handle, glaze, shoe style, sole, side band). 18 colour names, including the near pairs
  navy/black, charcoal/black, cream/white, burgundy/maroon and olive/forest green. Each product has
  a small Lab offset per colour (dye lots differ).
- **Listing image**: a studio render of the product in the listed colour on a plain light backdrop.
- **Delivered photo**: the delivered product on a bed cover (plain, striped, check or busy print),
  a table (light or dark wood, laminate) or a floor (tiles, planks, carpet), with rotation, a drop
  shadow, fabric folds, perspective, vignetting, one of three light levels, a colour temperature
  the simulated camera only partly corrects, white-balance error, defocus and motion blur, sensor
  noise, phone denoising and sharpening, and JPEG compression.

  | light | colour temperature | camera white balance | exposure | noise, blur |
  |---|---|---|---|---|
  | day | 5000-7200 K | 90-100% corrected | normal | low |
  | lamp | 2600-3400 K, falloff from a lamp | 70-92% corrected | lower | moderate |
  | dim | 2300-3200 K (70%) or 6500-9000 K | 55-85% corrected | dark | high, often motion blur |

- **Size-tag photo** (garments and shoes; mugs have no size): a woven or printed tag, or print on a
  shoe lining, on the item's fabric under the same light as the item photo. 14 fonts, size formats
  `M`, `SIZE M`, `TAILLE M`, `MEDIUM`, `M/38`, `US 9`, `US 9 UK 8 EU 42`, `9 US`, size text 10-34% of
  the tag height, rotation up to 35 degrees, bent tags, distracting lines (`RN 54321`,
  `STYLE 4410-22`, `MACHINE WASH 30°C`).

### Pairs and ground truth

600 pairs. Each pair is one listing (title, colour, size, attributes, listing image) and what was
delivered. Half match exactly. Half differ in exactly one way:

| mismatch type | how |
|---|---|
| colour | same product, another of its colours: 40% navy/black (oversampled on purpose), 30% the other near pairs, 30% clearly different colours |
| size | same product and colour, the next size up or down (shoes: 0.5 or 1 US size) |
| model | 2/3 another product of the same type (for example crew-neck vs V-neck), 1/3 another garment type, same colour and size |
| damage | same product with a stain, hole, tear or bleach mark (garments), a chip or crack (mugs), a scuff, stain or split sole (shoes) |

Every stratum (matches and each mismatch type and colour subtype) is spread evenly over day, lamp
and dim. Each manifest row records the truth (`expected`, `mismatch_type`, `mismatch_subtype`,
`delivered`) and every render parameter.

### Split and freeze

Products are split by product id, per product type: 30% to dev (18 products, 180 pairs), 70% to
test (42 products, 420 pairs). A product and any product it is swapped with are in one split only.
The generator writes `manifests/dev.json` and `manifests/test.json` (paths and sha256 of every
image) and then `manifests/test.freeze.json` with the sha256 of the test manifest, before any system
runs. `check-splits.mjs` fails if a product id is in both splits or the test manifest changed;
`--files` also re-hashes every image. The runner and the CLIP script refuse to run if it fails.

Before the freeze, a 24-pair preview from a different seed (`--preview`, in neither split) was looked at to fix rendering bugs (exposure on dark tables, wood grain, item size in frame). No system was run on it.

Dev is used for fitting, test only for scoring. Nothing is tuned on test. Dev fits two things:

- the CLIP threshold (`clip-threshold.json`);
- since the second test run, the service's colour confidence rules (threshold set
  `fitted-dev-2026-11-09`, see "Fitting the service thresholds" below). The hand-set set is kept as
  `initial-unfitted`.

The frozen test split has been run twice, each time once, with nothing changed in between except
what dev fitted:

1. 2026-11-08 20:53 UTC, service thresholds `initial-unfitted` (hand-set, nothing fitted), no model
   key.
2. 2026-11-08 21:30 UTC (2026-11-09 local time, hence the set's name), service thresholds
   `fitted-dev-2026-11-09`, no model key. Afterwards it was re-scored from its saved responses
   (`--reuse`, nothing sent to the service) to fix wording in the result file; same numbers.

Both runs' numbers are in `evals/results/sightbench.json` (`details.testRuns`) and in
`evals/RESULTS.md` (the "First test run" row and the baselines of the secondary metric). The first
run's full result file and raw responses are kept locally under `evals/data/raw/sightbench/`
(git-ignored). One caveat: when the colour rules were fitted, a description of the first run's false
alarms was known (colour calls on matching items under warm or dim light). No test values were used
to choose the rules or their values, but the second run is not blind to that kind of failure.

### Systems

| system | decision |
|---|---|
| Sightline | the `/verify` verdict |
| CLIP ViT-B/32 | cosine(listing image, delivered photo) below a threshold means mismatch; the threshold maximises balanced accuracy on dev only (`clip-threshold.json`); never abstains |
| colour only | the colour module's finding from the same call (any confidence; a strict variant uses the fusion's "sure" rule) |
| OCR only | the OCR read of the tag compared with the listed size |

### Metrics (test split only)

Mismatch recall, false-alarm rate (matching pairs called mismatch), abstention rate and coverage,
accuracy when not abstaining, and wrong-match rate, overall, per mismatch type and subtype, per
light level, per product type and per type x light cell. Proportions carry 95% Wilson intervals;
F1 (mismatch positive, `unsure` = not flagged) carries a seeded 95% bootstrap interval, and systems
are ranked by its lower bound. `/verify` latency p50/p95 is client wall time, one request at a time.
Worst cases (every false alarm, colour mismatches the colour module agreed with, wrong OCR reads,
CLIP's most similar mismatches and least similar matches, the weakest type x light cells) and every
pair's decisions are in `details`.

**Secondary metric, added after the first test run** (reported next to the primary metrics, never
instead of them, with Wilson intervals): *names the difference*. A mismatching pair counts when the
verdict is `mismatch`, or `unsure` with a disagreeing reason from the module that matches the true
mismatch type (colour -> colour, size -> size, model -> identity, damage -> damage). That is what the
buyer hears ("The size tag seems to read L, you ordered M, but I'm only fairly sure."), and the
money-back path is open for `unsure`. Its false-alarm twin is a matching pair whose verdict is
`mismatch` or that got any disagreeing reason: the buyer hears a difference that is not there. It
was defined after the first run's primary numbers were known; the first run's value is computed
from that run's saved per-pair rows. `details.colourCalls` also counts the colour module's "sure"
disagreements on pairs whose delivered colour is the listed one.

## Reproduce

```sh
# 1. Images, manifests, freeze (about 6 minutes, 3 processes). Re-running reproduces the frozen
#    bytes and stops instead of overwriting the freeze if anything differs.
cd evals/sightbench/py && uv run python -m sightbench.generate
node ../check-splits.mjs --files

# 2. CLIP baseline: fits the threshold on dev, then scores test (GPU if available, else CPU).
uv run --group clip python -m sightbench.clip_baseline

# 3. The service (no model key for this run), then the runner. One heavy process at a time.
#    VISION_THRESHOLDS=initial-unfitted reproduces the first test run; unset uses the fitted set.
#    VISION_URL points the runner at another port if 8011 is taken.
cd ../../../services/vision && uv run uvicorn app.main:app --port 8011
cd ../../evals && pnpm exec tsx sightbench/run.ts
pnpm evals:report
```

Runner flags: `--with-model` (the service must report `vlm.configured: true`; without the flag it
must report false), `--split dev`, `--limit N`, `--reuse` (reuse saved responses), `--no-write`.
`VISION_URL` picks the service (default `http://127.0.0.1:8011`). Dev and limited runs never write
the result file. Raw responses go to
`evals/data/raw/sightbench/responses/<no-model|with-model>/<threshold set>/` (git-ignored), so a run
with other thresholds never overwrites an earlier one. Each test run that writes the result file is
appended to `details.testRuns`; re-scoring the latest run from its saved responses (`--reuse`,
nothing sent to the service) replaces that entry instead of adding a run.

Image hashes depend on the pinned libraries (`py/uv.lock`) and on the system fonts listed in each
manifest (`fonts-dejavu`, `fonts-liberation`, `fonts-freefont-ttf`, `fonts-lato`).

### With the vision model

Start the service with `VISION_MODEL` and `ANTHROPIC_API_KEY` set, then
`pnpm exec tsx sightbench/run.ts --with-model`. Same frozen split, same baseline, same metrics; the
headlines and limitations say which mode produced them. Fit any service thresholds on dev only
(`VISION_THRESHOLDS` set name or override file), never on test.

### Fitting the service thresholds

Only on dev, with the runner's dev mode (`--split dev`, never writes the result file), which prints
the colour module's "sure" disagreements on pairs whose delivered colour is the listed one next to
the real colour swaps, and the secondary metric. Goal of the 2026-11-09 fit: no "sure" colour
disagreement on a right-colour item, keeping as many colour-mismatch calls as possible, with simple
rules. Three colour rules changed (the reasons and dev evidence are in
`services/vision/app/thresholds.json`, `fitted`):

- a "sure" colour disagreement needs an item photo that passes the quality gate (a failing photo
  lowers colour confidence one step, like dim light);
- without a white reference, it also needs delta E >= 10 after matching the delivered colour to the
  listing colour's brightness, so white read as grey is never "sure";
- below a 95th-percentile frame luma of 0.30 the colour check says it is too dark (under that, its
  disagreements on dev carried no information).

| dev, 180 pairs, no model key | `initial-unfitted` | `fitted-dev-2026-11-09` |
|---|---|---|
| colour "sure" disagreements, delivered colour right | 5 of 157 | 0 of 157 |
| colour "sure" disagreements, colour swapped | 1 of 23 | 1 of 23 |
| colour disagreements at any confidence, colour right / swapped | 42 of 157 / 8 of 23 | 19 of 157 / 5 of 23 |
| Sightline mismatch recall / false alarms | 3 of 90 / 3 of 90 | 1 of 90 / 0 of 90 |
| names the difference / false-alarm twin | 32 of 90 / 25 of 90 | 27 of 90 / 11 of 90 |

The 2 recall hits lost on dev were model swaps flagged by a wrong "sure" colour call. Dev has only 23
colour swaps, and only one of them was in a photo good enough for a "sure" call, so the fit is
coarse. Wood tables and plank floors: the colour check gives up because gray-world white balance
reads the orange surface as orange light. The masks there were checked on dev and are fine, so this
was left as an honest abstention rather than fitted away.

What the second test run showed (numbers in `evals/RESULTS.md`): the fit cut false alarms and the
false-alarm twin, but it also cut the real colour swaps the service flags, so it is a trade, not a
clean win. The same-brightness cut (10) rests on one dev swap (11.1). On test it held back three
swaps the first run had caught (royal blue delivered for navy at 7.1, navy for black at 9.2, black
for sky blue at 9.1) and let one wrong "sure" call through (a sky-blue tee under lamp light read as
slate, 11.7). Matching brightness to a near-black listing also squashes the delivered colour's
chroma, which is how black for sky blue came out under 10. These were found after the run and were
not fitted on test; the next fit needs more colour swaps in dev, and real photos.

## Two looks, quoted reads, one extra photo

Three changes to the check, scored by `looks.ts` into `evals/results/sightbench-looks.json`, next to
the numbers above (never instead of them):

- **Two looks before "sure"** (service `fusion.py`): a "sure" mismatch needs two independent
  signals that agree (two modules, or one module on two photos; a sure size already rests on the
  model read and OCR). Scored on all 420 test pairs from the module outputs the last with-model test
  run saved, with no new model call. Re-fusing those outputs with the old rule must reproduce every
  saved verdict, or `looks.ts` refuses to write.
- **Quote-or-unsure reads** (service `citation.py`): identity and damage reads must name a visible
  region and what is in it, checked in code. This changes the prompts and the output schema
  (`vlm.PROMPT_VERSION`), so it needs new model reads, capped at about 12 USD: a stratified test
  subset (half matching, mismatches spread over type and light, fixed hash order), not all 420.
- **One extra photo** (service `fusion.choose_retake`, `POST /recheck`): a "not sure" check asks for
  one shot chosen from why it was not sure (size tag close-up; the whole item in better light;
  white paper next to the item) and checks again with both photos. SightBench has one photo per
  item, so the extra photos are **simulated**: `py/sightbench/retake.py` renders them from the
  pair's own seed, so the item and its damage are the same (it re-renders the first pairs' item and
  tag photos and stops unless the bytes are identical). `light` is a new day-light photo on a new
  surface; `paper` a new photo under the pair's own light with an A4 sheet of white paper beside
  the item; `tag` the pair's own tag under its own light, closer (80-92% of the width) and flatter
  (at most 8 degrees, not bent). Every number from these says "simulated retake".

```sh
cd evals/sightbench/py && uv run python -m sightbench.retake --split dev && uv run python -m sightbench.retake --split test
cd ../../../services/vision
# dev: develop the citation rules and the retake choice (new reads; size-tag reads too, no saved run)
uv run python -m app.looks_bench --env-file ../../.env.local --split dev \
  --manifest ../../evals/sightbench/manifests/dev.json --retakes ../../evals/sightbench/manifests/retake-dev.json \
  --sample 20 --cache ../../evals/data/raw/sightbench/looks/reads --ledger ../../evals/data/raw/sightbench/looks/spend.json \
  --budget-usd 11.5 --out ../../evals/data/raw/sightbench/looks/rows-dev.json
# test, once: two looks on all 420 pairs; quoted reads and a simulated retake on the subset
uv run python -m app.looks_bench --env-file ../../.env.local --split test \
  --manifest ../../evals/sightbench/manifests/test.json --retakes ../../evals/sightbench/manifests/retake-test.json \
  --first-cache ../../evals/data/raw/sightbench/responses/with-model/fitted-dev-2026-11-09 \
  --sample <n> --cache ../../evals/data/raw/sightbench/looks/reads --ledger ../../evals/data/raw/sightbench/looks/spend.json \
  --budget-usd 11.5 --out ../../evals/data/raw/sightbench/looks/rows-test.json
cd ../../evals && pnpm exec tsx sightbench/looks.ts && pnpm evals:report
```

What dev decided (20 dev pairs with new reads, plus colour-only checks of all 180 dev retakes, no
model): the citation rules accept a region like "overall silhouette" for the product type and do
not accept damage described with a harmless explanation ("a stain or just shadow"); and colour asks
for a photo in better light, not white paper, when the light was dim or tinted. Under the pair's
own tinted light the rendered paper was taken as a white reference in only 2 of 180 dev retakes,
and the paper photos gave 7 wrong "sure" colour disagreements on right-colour items and caught 1 of
23 swaps, against 0 and 7 of 23 for the day-light photos. White paper is asked for only when the
light was already fine. When several checks keep a pair from a match, the shot that re-checks the
most of them is asked for.

Model reads are cached per pair, photo and read under `looks/reads/<prompt version>__<model>__<effort>/`,
so changing a prompt (and `PROMPT_VERSION`) never reuses an old read, and re-running never pays
twice. `--env-file` takes only `VISION_MODEL`, `VISION_EFFORT` and `ANTHROPIC_API_KEY` from the file.
The ledger counts the API's token usage at list price and the bench stops before a call that could
pass `--budget-usd`; pairs it did not reach are reported as not run.

## Adding real photos

Follow `real/SHOTLIST.md`: photos go to `evals/data/raw/real/` (git-ignored, location data
removed), one row per item in `real/items.csv`. Then:

1. Write a converter that builds `manifests/real-<split>.json` in the same format as `test.json`:
   for each item, a true listing and a near-miss listing (one attribute changed, as the shot list
   says), the `lamp` and `dim` item and label photos as the delivered side, and as listing image
   the `day` item photo of the item the listing describes (for a colour near-miss, the partner
   item's photo). Record the changed attribute as `mismatch_type`.
2. Split by item id (keep near-miss partners together), write the manifest hashes and a
   `real-test.freeze.json` before running anything, and extend `check-splits.mjs` to cover it.
3. Run the runner on the real manifest and report it next to the synthetic numbers, never merged
   into the frozen synthetic test split.

## Files

- `py/` separate uv project (pinned; torch only in the `clip` group), so the service's env is untouched
- `manifests/{dev,test}.json`, `manifests/test.freeze.json`
- `clip-threshold.json` the dev-fitted CLIP threshold
- `check-splits.mjs` split and freeze guard
- `run.ts` the runner; writes `evals/results/sightbench.json` (test only), keeping every test run
  in `details.testRuns`
- `py/sightbench/retake.py` and `manifests/retake-{dev,test}.json` the simulated extra photos
- `looks.ts` scores two looks, quoted reads and one simulated extra photo from the rows of
  `services/vision` `app/looks_bench.py`; writes `evals/results/sightbench-looks.json`
