# Architecture

Sightline is a voice-first shopping agent for blind and low-vision buyers. It reads a purchase back, takes payment only after two confirmation keys, can hold the money until the buyer has checked the parcel, and builds signed evidence when the parcel is wrong.

This document describes the code as it is. File paths are relative to the repo root. Where something is simulated, missing or unproven, it says so. Section 10 lists what is live and what is not.

## 1. Overview

```
                        buyer (screen reader, keyboard, voice, phone camera)
                                          |
                                          v
 +--------------------------------- apps/web (Next.js 16, Node) ------------------------------------+
 |  pages: /app (buyer), /app/check/[id] (camera), /helper/[token], /merchant, /judge, /receipts/[id]|
 |         /evidence/[id]                                                                            |
 |  API:   /api/turn  /api/orders/[id]/check  /api/orders/[id]/money-back  /api/cases/[id]/send      |
 |         /api/orders/[id]/helper  /api/helper/[token]/*  /api/merchant/*  /api/webhooks/paypal     |
 |         /api/demo/start  /api/judge/run  /api/voice/token  /api/blobs/[id]  /api/receipts/[id]    |
 |                                                                                                   |
 |  server/conductor.ts  grammar -> intent -> search | details | readback | confirm | money back     |
 |        |                 (packages/agent: deterministic grammar, templates, ranking)               |
 |        v                                                                                          |
 |  server/payments.ts --> packages/gate (8 guards + reservation) --> packages/paypal (Orders v2)    |
 |        |                         |                                        |                       |
 |        |                         v                                        v                       |
 |        |               receipts (HMAC + Ed25519)                   PayPal sandbox REST            |
 |        v                                                                  |                       |
 |  server/audit.ts (hash-chained log)                    webhooks <---------+  (signature verified |
 |                                                                              by PayPal's API)     |
 |  server/vision.ts ----------------------------+        server/ai.ts ---------> Anthropic API      |
 +-----------------------------------------------|----------------------------------------------+
        |                                        |  multipart: photos + listing JSON
        v                                        v
  Postgres (Drizzle)               services/vision (FastAPI, Python 3.12, private service)
  carts, readbacks, orders,          quality -> mask -> colour (CIELAB/CIEDE2000)
  receipts, audit_log, blobs,        size tag: model read + OCR read
  evidence_packs, cases ...          identity + damage: model reads
                                     fusion (rules) -> match | mismatch | unsure

  packages/catalog   Demo Store catalog, or Channel3 when CHANNEL3_API_KEY is set
  packages/evidence  canonical JSON, domain-separated SHA-256, chain, HMAC, Ed25519, manifests
  packages/core      Money (integer cents), types, env + assertSandbox()
  packages/browser   read-only page reader (not called by any route; see section 10)
  apps/mcp           MCP server (stdio, Streamable HTTP): readback, key 1, delivery check, evidence
```

Data flow in one line each:

1. Buyer speaks or types. `POST /api/turn` runs `handleTurn` (`apps/web/src/server/conductor.ts`). A deterministic grammar (`packages/agent/src/grammar.ts`) picks the intent. What it fully understands (a complete search, a number, confirm, cancel, wait, repeat, help, money and memory questions, "buy my usual again") stays on that fast path. Open requests (a gift, "warm but not scratchy", a question about the options) go to the shopping agent, a Claude tool loop (section 6.5); when it can't finish, the turn falls back to the grammar.
2. Search results come from `packages/catalog`: the Demo Store's own inventory, plus live Channel3 results when a key is set (`createMergedCatalog`). Each listing is read by `interpretListing` (`packages/agent/src/listing.ts`: its colour from its own words, the size asked for from the sizes it offers) and ranked (`packages/agent/src/ranking.ts`: team or fan merchandise, another size and avoided materials are left out with a reason). Each product the buyer might buy is frozen as a hashed `ProductSnapshot` (`packages/catalog/src/snapshot.ts`).
3. `startReadback` builds a cart, hashes it, and composes the readback from a template (`packages/agent/src/readback.ts`). Nothing a model wrote is in it.
4. The confirmation state machine (`packages/agent/src/confirm.ts`) needs two keys. Then `payForReadback` (`apps/web/src/server/payments.ts`) runs the gate and, if it allows, creates the PayPal order.
5. After delivery the camera check posts photos to `/api/orders/[id]/check`. The vision service returns a verdict. `afterVerdict` (`apps/web/src/server/after-check.ts`) captures, leaves the hold, or offers money back.
6. Money back builds a signed evidence pack and sends the case to the store. A held payment stays held until the store accepts the return (void) or offers a replacement; with no answer in three business days the hold sweep voids it (`server/holds.ts`). A store offer sets a new deadline (10 business days, time for a return to arrive) and the hold is voided if the case is still open then; an agreed replacement pays the store a week after the agreement. The sweep also pays the store a week after an unchecked delivery, retries failed captures, tells the buyer a day before a held case's deadline what happens at it, and reauthorizes a held authorization each time its three-day honour period runs out, inside PayPal's 29 days (each reauthorization numbered into its request id). It runs from `POST /api/maintenance` every 15 minutes (render.yaml cron) and, throttled, when a demo starts.
7. When a case reaches the store, Demo Store's own agent reads it after the buyer's reply is sent (`server/store-agent.ts`, section 5.4) and answers inside the store's policy or leaves a proposal for staff.

## 2. Order lifecycle state machine

Order status is a text column (`packages/db/src/schema.ts`, `orders.status`). The allowed names are the `OrderStatus` union in `packages/core/src/types.ts`. There is no database constraint or central transition function. Each transition is a direct `UPDATE` in the file listed below, so the table is the real specification.

### Statuses and what drives them

| Status | Written by | Trigger |
|---|---|---|
| `confirmed` | `server/payments.ts` (`payForReadback`) | The gate allowed the payment and the local order row was inserted. Also the resting state when PayPal's answer is lost (see "outcome unknown"). |
| `approval_pending` | `server/payments.ts` | First purchase, no vault: PayPal order created, waiting for the buyer to approve in PayPal's window. |
| `authorized` | `server/payments.ts` (`settleCreatedOrder`) | Pay-after-check order (`intent: AUTHORIZE`): PayPal authorized the amount. `authorizationId` and `authorizationExpiresAt` are stored. |
| `captured` | `server/payments.ts` (`settleCreatedOrder`); `server/webhooks.ts` | `intent: CAPTURE` order captured. The webhook `PAYMENT.CAPTURE.COMPLETED` also sets it, but only from `approval_pending` or `confirmed`. |
| `failed` | `server/payments.ts` | PayPal returned a definite error (a 4xx that is not "ambiguous"). The budget hold is released. |
| `delivered` | `server/merchant.ts` (`markDelivered`); `server/lifecycle.ts` | Demo control: the Demo Store marks the parcel delivered. Applied from `captured`, `shipped` or `authorized`. |
| `verified_match` | `server/after-check.ts`; `server/webhooks.ts` | Verdict `match`. For a held order the capture is attempted first and `captureId` is stored. |
| `verified_mismatch` | `server/after-check.ts` | Verdict `mismatch`. Nothing moves. The buyer is offered money back. |
| `verified_unsure` | `server/after-check.ts` | Verdict `unsure`. Payment unchanged. A helper link or a retake is offered. |
| `case_open` | `server/cases.ts` (`sendMoneyBack`) | Money back on an order that is not held: the case goes to the seller. |
| `voided` | `server/cases.ts`; `server/merchant.ts` (`respondToCase`); `server/webhooks.ts` | The PayPal authorization was voided (buyer path, merchant refund of a held order, or `PAYMENT.AUTHORIZATION.VOIDED`). |
| `resolved_refund` | `server/merchant.ts`; `server/webhooks.ts` | Merchant refunded a capture or accepted a dispute claim, or the webhook `PAYMENT.CAPTURE.REFUNDED` / `REVERSED` arrived. |
| `resolved_partial_refund` | `server/offers.ts`; `server/webhooks.ts` | The buyer accepted "keep it for less": on a hold, PayPal captured only the rest (`final_capture`) and released the part; on a capture, PayPal refunded the part. A `PAYMENT.CAPTURE.REFUNDED` for less than the order keeps this status. |
| `shipped`, `resolved_replacement`, `resolved_seller_favour`, `closed`, `readback_pending` | nothing | Declared in the type, never written. Shipping state lives in the `shipments` table, not in `orders.status`. |

### Transitions

```
 gate allows ---> confirmed --(vault: create + authorize/capture)-----------------+
                     |  |                                                         |
                     |  +--(no vault: PayPal order created)--> approval_pending --+ buyer approves,
                     |                                                           |  server authorizes/captures
                     |                                                           v
                     |                                       authorized (AUTHORIZE) | captured (CAPTURE)
                     |                                                           |
                     +--(PayPal error, definite)--> failed                       v
                     |                                              delivered (demo control)
                     +--(PayPal answer lost)--> stays `confirmed`                |
                         = outcome unknown                                       v  buyer's camera check (any status)
                                                      +--------------------------+-----------------------+
                                                      v                          v                       v
                                               verified_match            verified_mismatch        verified_unsure
                                          held:  capture auth, store          |                     (retake, helper)
                                                 captureId                    |  "get my money back"
                                          not held: nothing to do             v
                                                                held ----> void auth ----> voided (case resolved)
                                                                not held -> case_open ---> merchant refunds ---> resolved_refund
```

"Held" is `isHeld(order)` in `server/after-check.ts`: `intent === 'AUTHORIZE'`, an `authorizationId`, no `captureId`, status not `voided`. It does not depend on `status`, so delivery does not change whether money is held.

### Pay-after-check: authorize, then capture or void

- The buyer's `payAfterCheck` preference (default true, `packages/db/src/schema.ts`) picks `intent: AUTHORIZE` in `payForReadback`.
- Match and held: `afterVerdict` calls `payments.captureAuthorization` with `PayPal-Request-Id = paypalRequestId('capture', authorizationId)` and `finalCapture: true`. It commits the budget reservation and attaches any tracking that was waiting for a capture (`attachPendingTracking`).
- Capture fails after a match: status becomes `verified_match`, `captureId` stays empty, the money stays held, and the buyer hears "I'll try again". No job retries it. Running the check again would retry the capture.
- Mismatch and held: nothing is captured. On "get my money back" `sendMoneyBack` calls `payments.voidAuthorization` with `paypalRequestId('void', authorizationId)`, sets `voided`, resolves the case and releases the reservation.
- Mismatch and not held (capture-now order, or already captured): a case is opened with the seller instead (see section 5).
- Nothing in the app voids or reminds before `authorizationExpiresAt`. PayPal lets the authorization lapse.

### "Outcome unknown"

When `orders.create`, `authorize` or `capture` ends in a network error or a 5xx (`isAmbiguous` in `server/payments.ts`), PayPal may or may not have created the order. The code:

- keeps the budget reservation (does not release it),
- keeps the local order row and sets its status to `confirmed`,
- writes audit action `order.outcome_unknown`,
- returns `kind: 'unknown'` and says "I can't tell yet whether that payment went through. I've paused this purchase so you can't be charged twice."

There is no `unknown` status value. The state is "status `confirmed`, no `paypalOrderId`, reservation `reserved`, audit entry present". A retry of the same readback is refused by `DuplicateGuard` while the order or the hold is inside the 10-minute duplicate window, and the original `PayPal-Request-Id` would make PayPal return the first order if it did exist. Nothing polls PayPal to settle the question. The webhook handler cannot match such an order because `paypalOrderId` was never saved. See `docs/THREAT_MODEL.md`, known gaps.

## 3. The payment path

### 3.1 Readback

`composeReadback` (`packages/agent/src/readback.ts`) is a pure function of the cart. It refuses a cart whose totals do not recompute (`ReadbackError`). Missing listing facts are read as "the listing doesn't say". Contradictions inside a listing (for example the colour field says navy and the description says black) are added by `listingWarnings` (`packages/agent/src/warnings.ts`), also deterministic. The conductor hashes the final text with `hashReadbackText` and stores it in `readbacks` together with the cart hash.

The cart hash (`packages/evidence/src/subjects.ts`, `hashCart`) covers the user id, each line's recomputed snapshot hash and quantity, and the totals. It leaves out the cart id, so the same goods for the same person hash the same, which is what lets the duplicate guard see a repeat.

Money is integer cents (`packages/core/src/money.ts`). Tax, shipping and delivery date come from `packages/catalog/src/pricing.ts` (8% tax, flat $4.99 shipping under $30, three business days). These are Demo Store rules.

### 3.2 Two-key confirmation

`decideConfirmation` in `packages/agent/src/confirm.ts` is the state machine. Its state (`open`, `awaiting_second_press`, `confirmed`, `cancelled`, `change_requested`) is kept in `conversations.state` (server side), keyed by the readback text hash. A different readback discards old state.

- Key 1 is deterministic: `matchConfirmationPhrase` accepts an utterance only if all of it is an allowed phrase plus fillers and affirmatives. Questions, conditionals, reported speech, hedges, negation, hesitation and non-Latin or listed foreign words are vetoes. Or key 1 is the Confirm button.
- Key 2 is either a separate model call (`confirmationClassifier` in `apps/web/src/server/ai.ts`, label `confirm | not_confirm | unclear`, 4 second timeout, `FAST_MODEL`) or, when the button was used and the classifier errors or is unavailable, a second deliberate press at least 500 ms after the first.
- "Wait" sets `holdOpen`; there is no time limit on an open readback. "Cancel" and "change" are terminal for that readback and invalidate it.
- On `confirmed`, the conductor writes `readbacks.confirmedAt` and a `confirmation` record: `phraseMatched` (key 1 was phrase or button), `classifierAgreed` (key 2 was classifier or second press), the utterance and the time.

The gate trusts that record. It checks it is complete, ordered in time and recent. It cannot re-run the classifier. A pure two-press confirmation on the button path never calls a model.

### 3.3 The gate: eight guards and the reservation

`runGate` (`packages/gate/src/gate.ts`) runs the guards in a fixed order (`GUARD_ORDER`). Callers cannot remove or reorder them. The first failure stops the run. A guard that throws fails closed as `GUARD_ERROR`.

| # | Guard | File | Refuses when |
|---|---|---|---|
| 1 | `EnvGuard` | `guards/env.ts` | `assertSandbox` fails, the clock is invalid, or source/intent is not `vault`/`paypal-popup` and `CAPTURE`/`AUTHORIZE`. |
| 2 | `ReadbackBindingGuard` | `guards/readbackBinding.ts` | Readback text does not hash to its `textHash`; cart does not hash to its `hash`; cart belongs to another user; readback is for another cart; not confirmed; only one key agreed; timestamps out of order; confirmed more than 5 minutes after the readback (unless `holdOpen`); confirmation older than 5 minutes at decision time. |
| 3 | `CatalogPriceGuard` | `guards/catalogPrice.ts` | Amount differs by one cent from `sum(snapshot price x quantity) + shipping + tax`, recomputed from the snapshots and the catalog's own `quoteExtras`. Quantity must be an integer from 1 to 999. |
| 4 | `PayeeGuard` | `guards/payee.ts` | More than one seller, payee differs from the listing's seller, or the payee is not on the allowlist (one entry: `PAYPAL_MERCHANT_ID`). |
| 5 | `BudgetGuard` | `guards/budget.ts` | Over the per-order cap, or committed spend plus active holds plus this order is over the daily cap. Defaults: $100 and $250, set in `preferences`. |
| 6 | `DuplicateGuard` | `guards/duplicate.ts` | An order (not `failed`/`voided`) or an active hold exists for the same cart hash inside 10 minutes. The window can be made longer, never shorter. |
| 7 | `RateLimitGuard` | `guards/rateLimit.ts` | At least `maxOrdersPerHour` (default 5) orders plus holds in the last hour. |
| 8 | `FreshnessGuard` | `guards/freshness.ts` | A snapshot is 15 minutes old or older (the conductor re-reads snapshots older than 12 minutes before building a readback). `apps/web/src/server/gate-ports.ts` provides no `refreshSnapshot` port, so an old snapshot is a refusal. |

When all eight pass, the gate takes the reservation. `dbReservations.reserve` (`apps/web/src/server/gate-ports.ts`) runs in one transaction that locks the user's `preferences` row (`SELECT ... FOR UPDATE`) and re-checks the per-order cap, duplicate, daily cap and hourly count. Two concurrent confirmations cannot both fit. The reservation key is the `PayPal-Request-Id`, so a replay of the same confirmation returns the existing hold. Time-to-live is 30 minutes for `CAPTURE` and 29 days for `AUTHORIZE` (`gate.ts`). The hold becomes spend on capture (`commit`) and is released on a definite failure, a void, or expiry.

Every decision, allowed or refused, produces a receipt (3.5). If the receipt cannot be written, the hold is released and the decision becomes a refusal (`RECEIPT_WRITE_FAILED`).

### 3.4 PayPal Orders v2

`payForReadback` builds the call from database rows only: the cart row, the readback row and `preferences`. The package is `packages/paypal` (typed client, zod-checked responses, retries on 429/5xx/network, one token refresh on 401).

- `PayPal-Request-Id` for create is `paypalRequestId('order', cart.hash, readback.id)` (`packages/evidence/src/requestId.ts`): `base32(sha256("SIGHTLINE_ORDER_V1" || cartHash 0x1f readbackId))`, first 36 characters. The same confirmation always gives the same id. Authorize, capture, void and refund use the same function with their own kind tag and the PayPal order or authorization id. `assertRequestId` (`packages/paypal/src/http.ts`) rejects a missing id on money-moving calls.
- `custom_id` carries `hashReadbackBinding(readback)`, a domain-separated hash of the readback id, cart id, cart hash and text hash. It fits in the 127 characters the client keeps (`packages/paypal/src/orders.ts`). `invoice_id` is our order id.
- `payee.merchant_id` is `PAYPAL_MERCHANT_ID`. `expectedTotal` makes the client recompute the total from line items, tax and shipping and refuse a mismatch before the call.
- Vault: the first purchase sends `store_in_vault: ON_SUCCESS`, `usage_type: MERCHANT`, `customer_type: CONSUMER` and the buyer approves once in PayPal's window (JS SDK v6 button). Later purchases send the `vault_id` with `payment_initiator: CUSTOMER`, `usage: SUBSEQUENT`, so only the spoken confirmation is needed. The vault id is stored in `vault_tokens`.
- Approval path: `completeApprovedOrder` looks up the order by PayPal order id and user id, reads the order from PayPal, and authorizes or captures it server-side. The browser only reports "approved"; it supplies no amount.

### 3.5 Receipts

`signReceipt` (`packages/evidence/src/receipt.ts`) hashes the receipt body (canonical JSON, RFC 8785 subset, `packages/evidence/src/canonical.ts`) with a domain-separated SHA-256 (`SIGHTLINE/v1/receipt`, `hash.ts`) and signs the hash with HMAC-SHA256 under `RECEIPT_SIGNING_KEY` (at least 32 bytes). `recordReceipt` in `gate-ports.ts` also adds an Ed25519 signature over the same hash. The Ed25519 key pair is derived from the same secret through a domain-separated seed (`ed25519.ts`), and the public key is served at `/.well-known/sightline-keys.json`.

The receipt body holds the decision, the first failing guard, every guard result with details, the environment, the readback hashes, the confirmation record (including the utterance), the payee, the amount, and each line's snapshot hash. `/receipts/[id]` recomputes the hash and both signatures on load (`apps/web/src/server/receipts.ts`). `scripts/verify-receipt.mjs` checks the hash and the Ed25519 signature offline with Node only. It cannot check the HMAC, because that needs the secret.

### 3.6 Audit log

`audit()` (`apps/web/src/server/audit.ts`) appends to `audit_log` inside a transaction holding `pg_advisory_xact_lock(4242)`. Each row's hash is `hashObject('audit', { prevHash, entry })`, so each entry commits to the one before it. Gate decisions, readbacks, confirmations, order events, checks, evidence, helper events, case events and webhooks write entries. `verifyChain` exists in `packages/evidence/src/chain.ts` and is unit-tested. No route or job in `apps/` calls it.

PayPal calls record PayPal's own ids and the status PayPal answered (order, authorization, capture, refund, void, reauthorization), and processed webhooks record the resource id and status of the signature-verified event. Entries written before this was added have ids without a status.

### 3.7 The order timeline

`orderTimeline` (`apps/web/src/server/timeline.ts`) turns one order's audit entries into "What your agent did" on the order page (`components/orders/agent-timeline.tsx`) and on `/judge` (the visitor's own latest demo order, else the lifecycle run's). It joins entries about the order and its readback, `agent.step` entries tagged with the order's readback id, and the buyer's conversation steps since their previous order. Each step says who did it (you, your agent, the store's agent, store staff, PayPal, your helper, the safety check), the tool, whether a model, fixed rules or a person decided, and PayPal's id and status with where the status came from (PayPal's answer or a verified webhook). Nothing is inferred: an action with no entry shows no step.

## 4. The unboxing check

### 4.1 In the browser

`apps/web/src/lib/quality.ts` runs framing checks on downscaled camera frames: too dark, too bright, blurry, glare, too far, too close. It speaks guidance ("move back a little"). It mirrors the vision service's gate. It is advice only; the server re-checks every captured photo.

### 4.2 Photo sanitising

Two layers, both on the way in:

1. `POST /api/orders/[id]/check` runs `sanitisePhoto` (`apps/web/src/server/blobs.ts`) on every upload before any is stored: 12 MB cap; the type is read from the bytes, not the browser's label, and must be one this build of sharp decodes (`allowedPhotoTypes`: `sharp.format` at runtime, plus a HEIF round trip per codec, because prebuilt sharp decodes AVIF but not iPhone HEIC); EXIF orientation applied, then re-encoded by sharp to JPEG at most 2000 px, without calling `withMetadata`. A damaged or undecodable photo is a 422 with words the buyer can act on, and nothing is stored. In the browser, `lib/photo-file.ts` decodes an added file first (`createImageBitmap`): one it can't read is refused at once, and one it can read but the server may not (HEIC in Safari, AVIF, GIF, TIFF) is re-encoded to JPEG from its pixels. Re-encoding drops EXIF, GPS and camera serials. The stored blob and the bytes sent on are the sanitised ones. Blobs go into Postgres (`blobs.bytes`) with the owner's user id.
2. `services/vision/app/imageio.py` sanitises again on every image, uploaded or fetched: it removes the EXIF GPS directory and XMP packets, keeps the capture time, and re-encodes the pixels that go to the model.

### 4.3 Vision pipeline

`apps/web/src/server/vision.ts` posts the photos (`item`, `label`, `damage`), up to three listing images and a `listing` JSON (title, colour, size, attributes) to `${VISION_SERVICE_URL}/verify` with a 45 second timeout. The service (`services/vision/app/pipeline.py`) isolates each module: an exception becomes an `unknown` finding, not a failed request.

| Module | File | What it does |
|---|---|---|
| Quality | `quality.py` | Luma, sharpness, glare, framing on each item photo. The sharpest usable photo is chosen. A poor photo can still produce a mismatch but never a match. |
| Mask | `mask.py`, `background.py` | GrabCut seeded by a centre rectangle and a fitted background surface. No model weights. |
| Colour | `colour.py`, `colour_names.py` | White balance from a paper reference when visible, else gray world over the background. Dominant colour by deterministic k-means in CIELAB. Compared with the listing images and the listed colour name by CIEDE2000 (kL = 2). Abstains in very dim or tinted light. No model. |
| Size tag | `label.py` | Read A: model read of the tag. Read B: RapidOCR. Two agreeing reads are `sure`; one read is at most `fairly_sure`; two different reads are `not_sure`. |
| Identity | `identity.py`, `vlm.py` | Model compares named attributes (neckline, sleeves, pattern, logo placement, closure, pockets, shape, material look) between item and listing photos. |
| Damage | `damage.py`, `vlm.py` | Model reports tears, stains, broken parts, missing pieces as `clearly`, `possibly`, `no`, `cannot_tell`. |
| Fusion | `fusion.py` | Rules over the module outputs (below). |

The model client (`vlm.py`) uses JSON-schema structured output with enumerated fields. Its system prompt says text in photos and listing fields is data, not instructions. With no `VISION_MODEL` or `ANTHROPIC_API_KEY` it is a null client and every model-backed module reports `unknown`.

### 4.4 Fusion and abstention

`fuse` in `services/vision/app/fusion.py`, with thresholds in `services/vision/app/thresholds.json` (`"version": "fitted-dev-2026-11-09"`: the hand-set values with the colour confidence rules fitted on the synthetic SightBench dev split; the hand-set set is kept as `initial-unfitted`):

- `mismatch` requires at least one `disagree` reason at `sure` confidence.
- A disagreement below `sure` gives `unsure`.
- `match` requires colour (at least `fairly_sure`), size (`sure`) and identity (`fairly_sure`) to agree, no disagreement anywhere, and no quality problem reported.
- Everything else is `unsure`, with next steps (better light, closer tag photo, ask a helper).
- Sentences use `sure / fairly sure / not sure`, never percentages.

No model sets the verdict. A model can supply a size read, an identity attribute comparison or a damage finding. Fusion code turns those into a verdict.

### 4.5 From verdict to money

`afterVerdict` (`apps/web/src/server/after-check.ts`) reads only `verdict.kind` and the order's payment fields. It never reads reason text or any model output. Match captures a held order. Mismatch changes nothing about the money until the buyer asks for money back. Unsure changes nothing and offers a helper link.

The helper link (`apps/web/src/server/helper.ts`) is `<request id>.<nonce>.<HMAC>` under `HELPER_LINK_SECRET`; only an HMAC of the token is stored; it expires after 48 hours. The helper sees the listing and the photos, never amounts, payee or payment ids. The helper's answer is stored and the buyer is notified. The answer changes nothing about payment.

## 5. Money back

### 5.1 Evidence manifest and signatures

`prepareMoneyBack` (`apps/web/src/server/cases.ts`) builds the pack and sends nothing. `buildManifest` (`packages/evidence/src/manifest.ts`) embeds, whole:

- the order (ids, amount, payee, `PayPal-Request-Id`),
- the readback exactly as spoken, with its text hash and cart hash,
- the frozen listing snapshot,
- a file entry per photo (name, MIME, time, size, domain-separated SHA-256 of the bytes; the bytes themselves are not in the manifest),
- the verification verdict,
- the narrative.

It refuses to build if the snapshot or readback hash does not recompute. The manifest hash is signed with Ed25519 and stored in `evidence_packs`. `/evidence/[id]` recomputes the hash and checks the signature on load. `verifyManifest` also checks photo bytes against their hashes when given the bytes, and reports every problem it finds.

### 5.2 Void or case

`sendMoneyBack` runs only after the buyer has heard the summary and confirmed (`POST /api/cases/[id]/send`):

- Order held: void the authorization. Demo Store is never paid. The case is `resolved` with outcome `voided`.
- Order not held: the case moves to `seller_contacted` with a due date three business days out, and the order to `case_open`. This step is a local database state. It calls no PayPal endpoint.

The server does not require a `mismatch` verdict for either path. Ownership of the order is the only check. The "mismatch first" order is how the UI and the agent guide the buyer.

### 5.3 Merchant desk

`/merchant` (`apps/web/src/app/merchant`, `apps/web/src/server/merchant.ts`) is the Demo Store's console. It is a sandbox test merchant, not a real seller. It has demo controls: ship the right item, a wrong one, a damaged one, or nothing; mark delivered; send tracking. `respondToCase` offers four replies:

- Refund: if the case has a PayPal dispute id, it reads the dispute and uses its HATEOAS links (`accept_claim`, else `make_offer` with a `REFUND` type that the buyer must still accept). Else it refunds the capture (`refundCapture`). Else it voids the authorization. All with derived request ids.
- Replacement or return-first: `make_offer` on the dispute if one exists, otherwise a local offer record.
- No response: records the choice; nothing is sent.

Gaps in this flow: the web app never creates a PayPal dispute (`disputes.create` is not called; the buyer-side client in `packages/paypal/src/buyer.ts` exists but is not wired into the app), so `cases.paypalDisputeId` is only filled when a `CUSTOMER.DISPUTE.*` webhook arrives. There is no buyer route to accept or decline an offer. Case stages `accepted` and `declined` are displayed but never set.

### 5.4 The store’s agent

`server/store-agent.ts`, with the deterministic half in `packages/agent/src/store-agent.ts`.

- Trigger: `POST /api/cases/[id]/send` schedules it with `after()` once the buyer's answer is sent; a declined offer schedules a revision (`server/offers.ts`); staff can ask from the desk; the maintenance job picks up any case it has not read. One proposal row per trigger and one live proposal per round (`store_agent_proposals`, two unique indexes), so a repeated or racing trigger does nothing. At most two proposals per case, then it hands the case to staff. Staff replies, the agent's replies and the buyer's answers all take one advisory lock per case (`withCaseLock` in `server/merchant.ts`) and re-read the case inside it, so two replies never both go out and a late write never reopens a closed case; a staff reply supersedes a proposal still being worked on.
- It reads `loadStoreCase` (`server/store-case.ts`): the evidence pack's hash and Ed25519 signature are checked first (a pack that does not verify stops it), and the verdict comes from the signed manifest. Then the order's payment state, the store's own shipping record, offers already declined, and the store policy (`store_policies`, per demo scope; edited on `/merchant/agent`).
- Code lists the allowed replies (`storeOptions`): replacement; full refund, or releasing a hold; part refund of 20 or 50 percent, rounded to the cent from the order, when the policy allows it; item back first. It marks a reply as inside the policy only with auto-send on, the order under the staff limit and the evidence verified; a replacement also needs a wrong size or colour under its own limit, and a full refund needs the store's own record of a mistake or a sure check.
- The model (`claudeStoreAgent` in `ai.ts`, structured output with the option ids and fact ids as closed sets) picks one option and gives one to three reasons, each citing fact ids. `checkProposal` keeps a reason only if every amount, size, colour, date, number and quote in it is in the facts it cites, it describes only the reply chosen (never another option's money, never "refund" on a hold or a replacement), and it is about the evidence rather than the buyer or the store's internals. With no reason left, or no key, `rulesProposal` (the cases desk's rule-based suggestion) picks, and the proposal says why.
- Inside the policy the reply is sent through `respondToCase` or `offerPartialRefund` with `by: 'store_agent'`; otherwise it waits on the cases desk for Send, Change (any other allowed reply) or Dismiss. Sending re-reads the case and recomputes the amount; a mismatch sends nothing.
- The buyer's agent reads the offer with the reasons (`presentOfferChoice`); the offer card lists them. Accepting "keep it for less" settles at once (`settleKeepForLess`): the offer is claimed first, then PayPal captures the rest of a hold with `final_capture` or refunds part of a capture (which one was fixed when the offer was made), with request ids derived from the offer; a failure puts the offer back, and a retry asks PayPal for the same thing. A held offer's deadline stays inside the authorization's 29 days.
- Every step is `store_agent.step` in the audit chain, with the tool and who decided.

### 5.5 Webhooks

`POST /api/webhooks/paypal` (`apps/web/src/app/api/webhooks/paypal/route.ts`):

1. Read the raw body as text.
2. Call PayPal's verify-webhook-signature API with the raw body, the five transmission headers and `PAYPAL_WEBHOOK_ID` (`packages/paypal/src/webhooks.ts` builds the request by string concatenation so the signed bytes are not re-serialised). Not verified: 400. No `PAYPAL_WEBHOOK_ID`: 503.
3. Insert the event in `webhook_events` with a unique `paypal_event_id`. A duplicate is acknowledged and not processed again.
4. Return 200, then process after the response (`after()`): `PAYMENT.CAPTURE.COMPLETED`, `REFUNDED`, `REVERSED`, `PAYMENT.AUTHORIZATION.VOIDED`, `CUSTOMER.DISPUTE.CREATED/UPDATED/RESOLVED`, `VAULT.PAYMENT-TOKEN.DELETED`. Each updates order, case or vault rows, notifies the buyer and writes an audit entry.

If processing throws, the event keeps `processedAt = null` and `lastError`. Nothing retries it automatically.

## 6. AI use and its boundaries

### 6.1 Calls

Models are named by environment (`packages/core/src/env.ts`, `apps/web/src/server/ai.ts`). Defaults in code and `render.yaml`: `AGENT_MODEL=claude-opus-5-5`, `FAST_MODEL=claude-haiku-5-5`, `VISION_MODEL=claude-opus-5-5`. All calls use structured output (zod schemas in the web app, JSON schema in the vision service). The web client times out at 20 seconds with two retries. With no `ANTHROPIC_API_KEY` each call returns nothing and the app falls back (below).

| Call | Where | Model env | Input | Output used for |
|---|---|---|---|---|
| Confirmation key 2 | `ai.ts` `confirmationClassifier` | `FAST_MODEL` | Utterance and readback text, delimited as data | `confirm / not_confirm / unclear`. Can agree or veto. |
| Request parsing | `ai.ts` `extractShoppingQuery` | `AGENT_MODEL` | Utterance, only when the grammar returns `freeform` and the shopping agent is unavailable or could not finish | Search filters (category, colour, size, max price). |
| Shopping agent | `server/shopper.ts`, loop in `packages/agent/src/shopper/loop.ts` | `FAST_MODEL`, effort low | The utterance, what is on screen, saved preferences and the last few turns, then tool results (listing data, as data) | Which searches to run, which listings to present with a one-line reason, a clarifying question, an answer about listings, or a hand-off to the readback, a money answer or the memory recall (section 6.5). |
| Listing question | `ai.ts` `answerAboutListing` | `AGENT_MODEL` | One frozen listing and its review quotes, as data | Spoken answer in segments with citations. |
| Size tag, identity, damage | `services/vision/app/vlm.py` | `VISION_MODEL` | Sanitised, re-encoded photos; listing details as data | Structured findings for fusion. |
| Case narrative | `ai.ts` `writeCaseNarrative` | `AGENT_MODEL` | Item, amount, verdict reasons, merchant name | A two-sentence buyer summary and a message to the seller. |
| Store agent | `ai.ts` `claudeStoreAgent` | `AGENT_MODEL` (server-side refusal fallback on Opus and Sonnet) | The case as numbered facts built by code, and the allowed replies | One option id from a closed set, and reasons citing fact ids, checked by `checkProposal`. |

### 6.2 What model output can influence

- Key 2 of a confirmation. It can only add agreement to a key 1 that already passed, or veto. It cannot confirm alone.
- Search filters, which only change which snapshots are shown. Prices come from the catalog. The shopping agent's filters are its own search wording; a size, budget or lowest price it passes is used only when the buyer said it.
- Which listings are presented, and a one-line reason for each, after the grounding check (section 6.5).
- Which listing is handed to the readback, only when the buyer's words ask to buy.
- A proposed memory, only when its value is in the buyer's words; it is stored only after the buyer says yes.
- Spoken answers about a listing, after the grounding guard.
- Findings inside the vision service, which fusion rules turn into a verdict.
- The wording of the case summary and the seller message.
- Which of the replies code allows the store's agent proposes, and the wording of its reasons (after `checkProposal`).

### 6.3 What it cannot influence

- Amounts, payee, quantity, currency, order intent, PayPal request ids and every other field of the PayPal call. They come from database rows and are recomputed by the gate (guards 3 and 4).
- The readback text. It is a template over the cart.
- Whether a gate guard passes.
- Whether money is captured or voided. `afterVerdict` and `sendMoneyBack` read only the verdict kind and the order's stored payment fields. The verdict kind comes from fusion rules, and `mismatch` needs a `sure` disagreement.
- Any outbound call except to Anthropic. The shopping agent's tools are read-only (search, details, compare, order history) or end the turn by handing control to app code (present, ask, answer, readback, recall, money); none can pay, confirm, set an amount or store anything.
- Money answers. "What's on hold?" and the other money questions are computed in `packages/agent/src/money.ts` from order rows, PayPal ids and the audit chain, and spoken from templates; the agent can only choose which question was asked.

### 6.4 Grounding guard

`checkGrounding` (`packages/agent/src/grounding.ts`) is applied to `answerAboutListing` in `conductor.ts`. Each segment must cite a snapshot field or a verbatim quote from the listing's reviews. The guard extracts product tokens (money, numbers, sizes, colours, materials, dates, policy terms, listing features such as "machine washable") from each segment and requires each to be backed by a citation. A quote counts only if it appears verbatim in the archived text (case, whitespace and edge punctuation normalised), and a sentence that reports what reviewers said needs such a quote. Unsupported segments are replaced by "The listing doesn't say."

Dates are read against a clock the caller passes in (`packages/agent/src/when.ts`): "Friday", "next Tuesday", "Nov 14", "the 14th", "in 3 days", "by the weekend" all become days and must cover the day the cited source states. Each token also carries the polarity of its clause: "it doesn't come in navy" for a navy listing is caught, and a denial passes only when the cited field settles it ("it isn't wool" for a cotton listing). `evals/RESULTS.md` reports the development split and a held-out split written before these checks, both on scripted answers, not on model output.

The case narrative is not passed through the guard. The comment in `ai.ts` says the caller checks it, but `cases.ts` does not. The buyer hears the summary before anything is sent. The seller message is stored in the manifest as `narrative` and is part of what the Ed25519 signature covers. A template narrative is used when no model is available.

### 6.5 The shopping agent

`runShopper` (`packages/agent/src/shopper/loop.ts`) is a manual tool loop over the Messages API, run by `server/shopper.ts` on `FAST_MODEL` (Claude Haiku 5.5 by default) with effort `low`, strict tool schemas and `tool_choice: auto`. The system prompt and tools are stable and cached; the per-turn context (options on screen, saved preferences, the last few turns, the agent's own last question) is the first user message. Each turn is a fresh API conversation; nothing is replayed across turns. When the conversation page opens, the server sends a `max_tokens: 0` warm-up with the same prefix (at most every four minutes), so the first open request reads a warm cache: a cold first call measured about 10 seconds, warm turns 1 to 5 seconds.

| Tool | Kind | What it does |
|---|---|---|
| `search_products` | facts | One catalog search through the shared search core (`packages/agent/src/search.ts`), with saved preferences applied in code. Returns up to eight ranked listings with ids `p1`.., facts only, and what was left out and why. |
| `get_product_details`, `compare_products` | facts | The full frozen listing, or a side-by-side from listing data. |
| `get_order_history` | facts | Past orders by item, most often bought first, ids `h1`.. (for "my usual"). |
| `remember_preference` | proposal | Checked against the buyer's words (`draftFromProposal`); returned as a proposal the app asks about. |
| `present_options`, `ask_clarifying_question`, `answer_about_products` | finish | Up to three listings with reasons; one short question; a short answer with per-sentence product ids. |
| `start_readback`, `recall_preferences`, `money_question` | finish | Hand-offs to the template readback, the memory recall and the money answers. |

Checks in code, every turn:

- Ids: a product the agent names must have come back from a tool this turn or be on screen.
- Filters: a size, budget or lowest price the buyer didn't say is not applied, and the tool result says so.
- Grounding: every reason, lead, question and answer sentence goes through `checkFreeText` (`packages/agent/src/grounding.ts`): each product token (money, numbers, sizes, colours, materials, dates, policy terms, quotes) and each feature claim ("waterproof", "machine washable", "organic") must be in the listings it is about, or in the buyer's own words for leads and questions. A line that fails is not spoken; the template still reads the listing's facts.
- Readback: only when the buyer's words ask to buy (`hasPurchaseIntent`), only a size the buyer said, and the readback is the same template as always. A listing that offers several sizes and has none chosen gets "Which size would you like?" before any readback.
- Limits: six tool calls, six model calls, 16 seconds per turn (10 per call). A timeout, refusal, cut-off answer or plain-text finish ends in a fallback: if the agent already searched, the template presents that search; otherwise the grammar handles the turn.

Every meaningful step is written to the audit chain as `agent.step` (`server/agent-steps.ts`): `{ tool, step, summary, decided?, conversationId, threadId, readbackId? }`, `tool` one of `claude`, `channel3`, `catalog` (a Demo Store-only search), `memory`, `money`, `paypal`, `app` (the app's own templates), and `decided` one of `model`, `rules`, `person`. The order timeline (`server/timeline.ts`) shows these with readable tool names. A shopping thread starts with a new search; the `proposed_readback` step carries the readbackId and the seq of every earlier step in the thread (`threadSteps`), and later steps (PayPal's outcome) carry the readbackId. Lines the grounding check stopped are a `lines_stopped` step whose payload keeps the lines (`stopped`) as evidence; the timeline says only how many were left out.

Memory: preferences are stored in `memories` (`server/memories.ts`) only after the buyer says yes to "Shall I remember that ...?" (or said "remember that ..."). Searches apply them in code and say so ("Using your usual size M."); a gift uses none of them. Settings has "What I remember" (change, forget one, forget all); "forget my size" also clears a Settings size for the same kind of clothing, and says so.

## 7. The MCP server

`apps/mcp` uses `@modelcontextprotocol/sdk`. Transports: stdio (`src/stdio.ts`) and stateless Streamable HTTP at `/mcp` (`src/http.ts`, POST only, one server per request). It refuses to start unless PayPal is configured for the sandbox.

| Tool | File | Behaviour |
|---|---|---|
| `accessible_readback` | `src/tools/readback.ts` | Same composer as the app. Totals recomputed server-side. Returns text, fields, `text_hash`. |
| `check_confirmation_phrase` | `src/tools/confirmation.ts` | Key 1 only. `payment_allowed` is always `false`. |
| `verify_delivery` | `src/tools/delivery.ts` | Photos as base64 or https URLs to the vision service. An unreachable service is an error, never a verdict. |
| `build_evidence_pack` | `src/tools/evidence.ts` | Same manifest builder; signs with Ed25519 under a context-separated key (`mcp-evidence`), so it differs from the web app's key. Without `RECEIPT_SIGNING_KEY` it uses a key that lives for the process and says so in the output (`key_source: ephemeral`). |
| `verify_evidence_pack` | `src/tools/evidence.ts` | Recomputes hashes, checks the signature, optional key pinning and photo bytes. |
| `barrier_index` | `src/tools/barrier.ts` | Reads `evals/results/barrier.json`; says so if the audit has not run. That file is not in `evals/results/` in this checkout. |

Resource `sightline://readback-rules` carries the rules for an agent. None of the tools moves money. HTTP auth is an optional bearer key (`MCP_API_KEY`, constant-time compare); on loopback the Host header must be a local name (DNS-rebinding guard). The server has no connection to the web app's database; it works from what the caller passes in. The evidence it builds has `cartId` and `cartHash` empty because the caller supplied only the words.

## 8. Storage and data model

Postgres through Drizzle (`packages/db/src/schema.ts`, migrations in `packages/db/migrations`, run with `pnpm --filter @sightline/db migrate`).

| Area | Tables |
|---|---|
| Identity | `users` (all rows are demo personas, `is_demo`), `sessions`, `preferences` (verbosity, sizes, caps, `pay_after_check`), `helpers` |
| Conversation | `conversations` (agent and confirmation state as jsonb), `messages`, `notifications`, `memories` (what the buyer asked to be remembered) |
| Commerce | `product_snapshots`, `carts`, `readbacks`, `orders`, `vault_tokens`, `shipments`, `reservations` |
| Check and money back | `verifications`, `helper_requests`, `evidence_packs`, `cases`, `blobs` (photo bytes in `bytea`), `store_policies`, `store_agent_proposals` |
| Integrity | `receipts`, `audit_log` (hash chain), `webhook_events` |
| Defined, not used by any code | `passkeys`, `magic_links`, `push_subscriptions`, `idempotency_keys`, `barrier_audits`, `eval_runs` |

Unique constraints that carry weight: `orders.paypal_request_id`, `orders.paypal_order_id`, `reservations.key`, `webhook_events.paypal_event_id`.

Hashes stored: snapshot, cart, readback text, manifest, receipt, audit link, blob SHA-256. All use the domain-separated scheme in `packages/evidence/src/hash.ts`.

Eval results are JSON files in `evals/results/`, read by `/api/stats` and `/judge` on each request (`apps/web/src/server/stats.ts`). Four suites are present: confirmation, duplicates, grounding, red team.

## 9. Deployment on Render

`render.yaml` defines three resources in the Oregon region:

- `sightline-web`: Node 22 web service. Build: `pnpm install --frozen-lockfile`, build `@sightline/web`, `scripts/prepare-standalone.mjs`. Pre-deploy: run migrations. Start: the Next.js standalone server. Health check: `/api/health` (returns database status, `sandbox: true` and which integrations have keys, no secrets).
- `sightline-vision`: private service (`pserv`), Docker image from `services/vision/Dockerfile` (Python 3.12, non-root user, port 8011). Reached by the web service through `VISION_INTERNAL_URL`. It has no authentication of its own.
- `sightline-db`: managed Postgres.

Environment: `PAYPAL_ENV=sandbox` and `PAYPAL_API_BASE=https://api-m.sandbox.paypal.com` are fixed in the blueprint. `SESSION_SECRET` and `HELPER_LINK_SECRET` are generated by Render. `RECEIPT_SIGNING_KEY`, PayPal credentials, `PAYPAL_WEBHOOK_ID`, `PAYPAL_MERCHANT_ID`, `ANTHROPIC_API_KEY` and the other vendor keys are `sync: false`, set by hand in the dashboard. `ANTHROPIC_API_KEY` is set on both the web and vision services. The blueprint has no entry for the MCP server; it runs locally or wherever the user starts it.

CI (`.github/workflows/ci.yml`) runs a secret scan, `pnpm check`, the vision tests, and Playwright end-to-end tests with axe.

## 10. What is simulated and what is live

Be exact here. "Live" means the code path calls the real service when its key is present. `/judge` and `/api/health` report which keys are present at runtime. Nothing in the repo records a run against live keys.

| Area | Status |
|---|---|
| PayPal | **Sandbox only.** Every process calls `assertSandbox()` at boot and the gate's `EnvGuard` repeats it on every payment. The code calls Orders v2, Payments v2 (authorize, capture, void, refund), Vault, Shipment Tracking, Disputes (merchant side) and webhook verification. The spike write-ups in `docs/spikes/S1.md`, `S2.md`, `S3.md` have empty results ("Not run yet: needs PayPal keys"). `docs/spikes/S12.md` (screen readers in PayPal's approval window) has not been run. `packages/paypal/NOTES.md` records differences between the plan and PayPal's published schemas. Client behaviour is tested against fixtures in `packages/paypal/test`. |
| Merchant | **Demo Store**, a sandbox business account. `snapshotOf` always sets the seller to the Demo Store merchant, even for Channel3 products, so every order is placed with Demo Store at the listed price, not with the real retailer. |
| Shipping and delivery | **Demo controls.** The merchant console (and `runLifecycle` in `server/lifecycle.ts`) chooses what ships and when it is delivered. PayPal's Orders tracker has no delivered state, so delivery never comes from PayPal. |
| Parcel photos | The judge run and the guided demo use `apps/web/public/demo-parcel/*.jpg`, rendered by `scripts/demo-parcel-photos.mjs` from SVG with noise and perspective. They are synthetic. Real camera photos work through the same route. |
| Personas | Maya and Raj (`server/personas.ts`) are seeded demo users. `POST /api/demo/start` signs anyone in as one of them. There are no real accounts. |
| Catalog | Demo Store catalog by default. With `CHANNEL3_API_KEY`, the Demo Store's catalog and live Channel3 results together; if Channel3 fails, the Demo Store's results still come back. Orders are always placed with the Demo Store at the listed price. |
| Vision | Colour, mask, quality, fusion and OCR run locally in the service with no key. Size-tag read A, identity and damage need `VISION_MODEL` and `ANTHROPIC_API_KEY`. `services/vision/README.md` says the model client has only been exercised against a stubbed SDK and that only the colour confidence rules are fitted, on synthetic dev renders. SightBench (`evals/results/sightbench.json`) measures the service on synthetic renders only, without model reads. |
| Confirmation key 2 | Needs `ANTHROPIC_API_KEY`. Without it, two Confirm presses stand in. The confirmation eval ran key 1 only. |
| Evals | `evals/RESULTS.md` states that no suite ran against the PayPal sandbox ledger or a live model. The duplicate suite simulates PayPal's documented `PayPal-Request-Id` behaviour. The grounding suite uses scripted answers. The red-team suite uses a local ledger. Held-out sets were written by the author of the code. |
| Dev-only seed | `apps/web/scripts/dev-seed-order.ts` inserts an order in a chosen state for UI work; with `held` it adds a placeholder `SEED-AUTH-…` authorization so hold views show it (never sweep such an order: PayPal does not know that id). It refuses to run when `NODE_ENV=production`. |
| Browser reads | `packages/browser` (read-only page reader on a cloud browser, honours robots.txt, https only) is not imported by any app or route. The Checkout Barrier Index crawler is a separate script in `evals/barrier`. |
| Unused integrations | Keys for email, web push, object storage, Gemini, Twilio and AG Studio are accepted by the env schema, but no code path sends email or push, writes to object storage or calls those services. Photos are stored in Postgres. |
| Buyer-side dispute | Not created by the app. Offers cannot be accepted by the buyer in the app. Case "sent to seller" on a captured order is a local state. |
| Speech | Browser speech recognition by default. With `DEEPGRAM_API_KEY`, the server mints a 60-second token and the browser streams audio to the speech provider. |
| User testing | No blind or low-vision user has used it. `docs/research` holds the protocol and forms, not results. |
