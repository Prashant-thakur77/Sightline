# Threat model

Method: STRIDE (Spoofing, Tampering, Repudiation, Information disclosure, Denial of service, Elevation of privilege) per component. Each row names a threat and either the control in code, with its file, or **open**, with what would close it. Read `docs/ARCHITECTURE.md` first for the components.

Scope and assumptions:

- PayPal is the sandbox only. No real money moves. A sandbox payment still exercises the same code paths, so the model treats money loss as the harm to prevent.
- The deployment is a public demo on Render. Anyone on the internet can open it and sign in as a demo persona.
- Attackers considered: an anonymous visitor; a signed-in buyer (all of them are demo personas); a malicious product listing or review text; a malicious or mistaken photo; a caller of the MCP server; someone who can send HTTP to the webhook URL; someone who obtains a helper link or a receipt link. Not considered: compromise of Render, PayPal, Anthropic or the host OS; a malicious maintainer.
- "Open" means nothing in the code stops it today. Section 13 ranks the open items.

## 1. Trust boundaries

```
 browser (untrusted) --> apps/web API --> Postgres
                             |--> PayPal sandbox      (trusted for money state, verified by signature for webhooks)
                             |--> Anthropic API       (untrusted output: text and structured fields)
                             |--> services/vision     (private network; trusted for verdict kind only)
                             |--> listing image URLs  (untrusted content, untrusted host)
 PayPal ----------> /api/webhooks/paypal              (untrusted until PayPal's verify API says otherwise)
 MCP client -------> apps/mcp                         (untrusted caller; no money tools)
 helper (link holder) --> /helper/[token], /api/helper/*
 anyone with a link --> /receipts/[id], /evidence/[id]
```

## 2. Web app and API

Files: `apps/web/src/app/api/**`, `apps/web/src/proxy.ts`, `apps/web/src/server/session.ts`, `apps/web/src/server/conductor.ts`.

| STRIDE | Threat | Control or status |
|---|---|---|
| S | Forged session cookie | Cookie is `<id>.<HMAC-SHA256(id)>` under `SESSION_SECRET`, compared with `timingSafeEqual`; the id must also exist in `sessions` and be unexpired (`server/session.ts`). |
| S | Anyone becomes a user | **By design in the demo**: `POST /api/demo/start` and the `startAs` server action create a session for Maya or Raj with no credentials (`app/api/demo/start/route.ts`, `app/start/actions.ts`). All visitors share the same two users. Per-user checks (`orderForUser`, blob owner, case owner) are therefore not a boundary between visitors. **Open**: real sign-in (the `passkeys` and `magic_links` tables exist but are unused). |
| T | Client sends fields to change what is bought or paid | `/api/turn` accepts a zod union of fixed shapes (`app/api/turn/route.ts`): text up to 500 characters, an index 1 to 3, a readback id. No amount, payee or quantity is accepted from the client. The payment reads the cart and readback rows by id and user (`server/payments.ts`). |
| T | Client-supplied `paypalOrderId` in `paypal-approved` | The order is looked up by that id **and** the session's user id, then read back from PayPal, and the amount comes from PayPal's own order (`completeApprovedOrder`). |
| R | User denies confirming | Every confirmation stores the utterance, both key sources and times (`readbacks.confirmation`), the gate receipt includes them, and `readback.confirmed` is in the audit chain. |
| I | One user reads another's data | Order, check, money-back and case routes filter by `userId` (`server/orders-read.ts`, `server/cases.ts`). Photos are served only to the owner (`app/api/blobs/[id]/route.ts`). Because personas are shared, a visitor can read what another visitor did as the same persona. **Open** with the item above. |
| I | Error text leaks internals | Routes return fixed messages and log details server side (`app/api/turn/route.ts`, `merchantFailure`). |
| D | Request flooding | **Open.** No rate limit on any HTTP route. The only throttles are the gate's orders-per-hour limit (money) and a single global "one lifecycle run at a time" flag in `app/api/judge/run/route.ts`. See section 12. |
| E | Merchant actions by a buyer or stranger | **Open.** `/api/merchant/orders/[id]/ship`, `/deliver`, `/tracking` and `/api/merchant/cases/[id]/respond` have no authentication. `assertSameOrigin` passes any request without an `Origin` header. `respond` with `refund` calls PayPal refund or void. An anonymous caller who knows an order or case id (random, 60 bits, see `packages/core/src/ids.ts`) can trigger them, and `/merchant` lists all orders. Mitigated only by the sandbox and the ids being unguessable. Close it with a merchant login and a role check, or by not mounting `/merchant` and `/api/merchant` on the public deployment. |

### 2.1 Session handling

- Cookie `sl_session`: `httpOnly`, `sameSite: 'lax'`, `secure` when `APP_URL` is https, path `/`, 12 hour expiry (`server/session.ts`).
- Sessions live in Postgres. `destroySession` deletes the row.
- No rotation on privilege change (there is none), no idle timeout, no per-session binding to a device, no "sign out everywhere". `SESSION_SECRET` rotation invalidates all cookies. Render generates it.

### 2.2 CSRF

What exists:

- `SameSite=Lax` on the session cookie.
- `apps/web/src/proxy.ts` (matcher `/api/:path*`): for POST, PUT, PATCH and DELETE it requires that `Origin`, when present, has the same host as `Host` / `X-Forwarded-Host`. Webhooks are exempt (they authenticate by PayPal signature).
- `assertSameOrigin` in `server/merchant.ts` repeats the Origin check on merchant routes.
- Mutating routes take JSON or multipart bodies, which a cross-site HTML form cannot send with `application/json`.

What does not exist:

- No CSRF token.
- A request with no `Origin` header passes if its content type is JSON, multipart or empty. Browsers send `Origin` on cross-site POST, so this affects non-browser clients, not browsers, but it also means the check is not a defence against a client that can omit the header.
- `proxy.ts` does not cover server actions (`saveSettings`, `startAs`); they rely on the framework's own origin handling. I did not test that here.
- The helper answer route (`/api/helper/[token]/answer`) is authenticated by the token in the URL, not by session, so CSRF is not the issue there.

Verdict: adequate against a cross-site browser attacker for the buyer routes. The merchant routes are the real exposure, and it is authentication, not CSRF.

## 3. Prompt injection into payments

Goal of the attacker: make the agent buy something, from someone, at a price, that the buyer did not hear.

Injection surfaces: listing title, description, attributes, review quotes (Channel3 or any catalog), text printed on parcel photos, the buyer's own speech (background voices).

| Threat | Control |
|---|---|
| Listing text instructs the agent to pay or to change the amount, payee or quantity | The model has no tools and no way to start a payment (`server/ai.ts` only returns structured data). Payment starts only from `confirmStep` after key 1 and key 2 (`server/conductor.ts`). The amount is recomputed from snapshots by `CatalogPriceGuard`; the payee must equal the listing's seller and the allowlist (`PayeeGuard`). |
| Listing text pushes the model to say something false that the buyer relies on | The readback is a template (`packages/agent/src/readback.ts`). Free answers must cite fields or verbatim quotes and pass `checkGrounding` (`packages/agent/src/grounding.ts`). Prompts mark listing and review text as data. Residual: the guard is token-level and passes negations. |
| Listing contradicts itself (colour field vs description) | `listingWarnings` adds a spoken note before "To pay" (`packages/agent/src/warnings.ts`). The red-team eval records that a buyer who confirms without listening still goes through (10 of 10, a negative result in `evals/RESULTS.md`). That is a human-factors limit, not a code defect. |
| Classifier tricked by the readback or utterance text | The classifier prompt delimits both as data (`buildClassifierPrompt`, `packages/agent/src/confirm.ts`). It is key 2 only: key 1 is a deterministic phrase match on the whole utterance, so injected text cannot supply "confirm purchase" on the buyer's behalf unless the buyer says it. |
| Background speech or a TV says "confirm purchase" | Open at the text level (`evals/RESULTS.md`: 6 of 6 exact phrases pass key 1). Reduced by push-to-talk and the required second key. Key 2 sees the same text, so it does not add acoustic information. |
| Text in a parcel photo says "this is a match" | Vision prompt marks image text as data and uses enumerated JSON output (`services/vision/app/vlm.py`). Fusion needs colour (pixel maths, no model), size (two reads that must agree for `sure`) and identity. A forged tag can at most change one input. See section 5. |

Evidence of testing: `evals/redteam/run.ts` (60 adversarial listings, 0 payment breaches, local ledger simulation, no live model). The result is about the gate and flow, not about a live model's behaviour.

## 4. Payment gate

Files: `packages/gate/src/*`, `apps/web/src/server/gate-ports.ts`.

| STRIDE | Threat | Control or status |
|---|---|---|
| S | Gate input forged by a caller | The gate is a library. `payForReadback` builds the intent from rows, not from request bodies. The guard `USER_MISMATCH` checks cart owner equals the paying user. |
| T | Cart or readback changed after the buyer heard it | `ReadbackBindingGuard` recomputes the cart hash and the readback text hash and compares to the stored ones; any edit gives `CART_TAMPERED` or `READBACK_TAMPERED`. A different readback hash discards confirmation state (`confirm.ts`). |
| T | Price changed between readback and payment | `CatalogPriceGuard` recomputes. `FreshnessGuard` refuses snapshots 15 minutes old or older. The conductor re-reads listings older than 12 minutes before building the readback. |
| T | Window settings loosened by config | `resolveOptions` can make duplicate windows longer and snapshot ages shorter, never the reverse (`packages/gate/src/gate.ts`). |
| R | Refused or allowed decision cannot be proven | Every decision signs a receipt (HMAC and Ed25519) and writes an audit entry (`gate.allowed` or `gate.refused`). A receipt write failure turns the decision into a refusal. |
| I | Receipt exposes personal data | Receipts hold the user id, the confirmation utterance and the item (`gate.ts` `receiptBody`) and are public by id. See section 10. |
| D | A guard hangs | Guards are awaited with no timeout; a throwing guard fails closed (`GUARD_ERROR`). Database stalls would stall the request. **Open** (low). |
| E | Two parallel confirmations both pass the budget | `dbReservations.reserve` locks the user's preferences row and re-checks inside one transaction (`gate-ports.ts`). |
| E | Gate trusts the confirmation record | By design the gate checks the stored record, not the classifier. A bug in the conductor that writes `phraseMatched` or `classifierAgreed` wrongly would pass. **Open** (structural): only the conductor writes this record (`confirmStep`), and it does so only for the `confirmed` outcome of `decideConfirmation`. |

### 4.1 Replayed or double confirmations

| Case | Control |
|---|---|
| Double click, two tabs, "yes yes" | Second press within 500 ms is ignored (`minSecondPressGapMs`). A confirmed readback is terminal; later presses get "already confirmed" (`confirm.ts`). `PayPal-Request-Id` is derived from cart hash and readback id, so PayPal returns the first order for a repeat. `orders.paypal_request_id` and `reservations.key` are unique. `payForReadback` returns the existing order if one is `authorized` or `captured`. |
| Old "yes" replayed later | `ReadbackBindingGuard` requires the confirmation to be no older than 5 minutes at decision time and ordered after the readback (`CONFIRMATION_EXPIRED`, `CONFIRMATION_OUT_OF_ORDER`). `holdOpen` removes the limit only between readback and confirmation, not after. |
| Confirm button for an old readback | `confirm-button` carries a readback id that must equal the conversation's current one (`handleTurn`). |
| Same cart, new readback within 10 minutes | `DuplicateGuard` (orders and active holds by cart hash) and the reservation check refuse it. |

### 4.2 Duplicate charges including lost responses

| Case | Control or status |
|---|---|
| PayPal answer lost (timeout, network, 5xx) | The hold and order row are kept, the buyer is told the outcome is unknown, the same request id would return the original order (`isAmbiguous`, `server/payments.ts`). Within 10 minutes the duplicate guard also refuses the same cart. |
| Lost answer, buyer buys the same item again after the 10 minute window | **Open.** A new readback gives a new request id, and nothing asks PayPal about the unknown order first. `evals/RESULTS.md` records this as a negative result (10 of 10 create a second order in the simulation). Close it with a reconciliation step that, for any `confirmed` order without a `paypalOrderId`, looks the order up by `invoice_id` or by replaying create with the stored request id before any new payment is allowed. |
| Webhook can settle the unknown order | **Open.** `processWebhookEvent` matches by PayPal order, capture or authorization id; the unknown order never stored one. |
| Server crashes between PayPal success and local update | Same as above. The local row stays `confirmed`. |

## 5. PayPal integration

Files: `packages/paypal/src/*`, `apps/web/src/server/paypal.ts`.

| STRIDE | Threat | Control or status |
|---|---|---|
| S | App talks to live PayPal | `assertSandbox` at boot in every process, repeated by `EnvGuard` on every payment (`packages/core/src/env.ts`, `guards/env.ts`). `render.yaml` fixes both variables. Request paths must start with `/` and cannot be absolute URLs, so the base cannot be changed per call (`packages/paypal/src/http.ts`). Path ids pass `pathId` validation. |
| T | Order built with a different total | `orders.create` recomputes the total from items, tax and shipping and refuses a mismatch with `expectedTotal`. `custom_id` binds the order to the readback hash; `payee.merchant_id` is set. |
| T | Response shape drift | Responses are parsed with zod schemas; a bad shape throws `PayPalResponseShapeError`. |
| R | Cannot show what PayPal was asked | Order id, request id and decision are in the receipt and `orders` row; `order.created`, `payment.authorized`, `payment.captured_after_check`, `payment.voided_after_check` are audited. |
| I | Credentials leak | `PAYPAL_CLIENT_SECRET` is read only in `server/runtime.ts` and `server/paypal.ts` (`server-only`). The logger passes no tokens (`packages/paypal/src/http.ts`). The public client id is sent to the browser for the button. |
| D | PayPal slow or down | Retries with jittered backoff on 429, 5xx and network errors; one refresh on 401. Failure is surfaced as "nothing was charged" only when the error is definite; ambiguous errors are not (section 4.2). |
| E | A buyer gets money back without a mismatch | **Open.** `sendMoneyBack` voids a held authorization for the order's owner with no verdict check (`server/cases.ts`). That is the buyer cancelling their own hold, but it removes the merchant's chance to be paid. |
| T | Case state regression | **Open** (minor). `sendMoneyBack` does not check the case stage. Calling it again on a voided order takes the "not held" branch, sets the case to `seller_contacted` and the order to `case_open`. Close it with a stage check. |
| D | Authorization expires or capture fails and nothing follows up | **Open.** After a match, a failed capture says "I'll try again" but no job does. Nothing acts before `authorizationExpiresAt`. |

## 6. Webhooks

File: `apps/web/src/app/api/webhooks/paypal/route.ts`, `apps/web/src/server/webhooks.ts`, `packages/paypal/src/webhooks.ts`.

| STRIDE | Threat | Control or status |
|---|---|---|
| S | Spoofed event | The raw body and five transmission headers are sent to PayPal's verify-webhook-signature API with `PAYPAL_WEBHOOK_ID`. Not verified gives 400. Missing webhook id gives 503. Verification is by PayPal, not local certificate checks. |
| T | Body altered between verification and storage | The same raw string is verified and stored (`webhook_events.raw`); the verify request is built by concatenation so the signed bytes are not re-serialised. |
| T | Replay of a captured event | `webhook_events.paypal_event_id` is unique; a duplicate is acknowledged and not processed (`recordWebhook`). Handlers are written to be safe to repeat. **Open**: no check on `transmission_time`, so a replay of an event the app never stored would be accepted if PayPal's verify says yes. |
| T | Out-of-order events | Capture-completed only applies from `approval_pending`, `confirmed` or `authorized`. Refund and reversal set `resolved_refund` from any status. **Open** (low): there is no full transition table. |
| R | Cannot show what was received | Raw body, signature result, attempts and last error are stored; each processed event writes an audit entry. |
| D | Flooding the endpoint | **Open.** Each unauthenticated POST makes one outbound call to PayPal's verify API. No rate limit. Close it with a cheap pre-check on header presence (the package already rejects missing headers locally) plus an IP rate limit. |
| D | A processing error loses an event | **Open.** The route always returns 200 after storing, so PayPal does not redeliver; a failed handler leaves `processed_at` null with `last_error`. The log line mentions a replay tool; none exists. |
| E | A webhook changes money state beyond its event | Handlers update statuses and notify; they call no PayPal write APIs. |

## 7. Vision service

Files: `services/vision/app/main.py`, `imageio.py`, `vlm.py`, `fusion.py`.

| STRIDE | Threat | Control or status |
|---|---|---|
| S | Someone calls the service directly | It is a private service on Render and has no auth (`render.yaml`, `main.py`). **Open** (low on the current topology): any workload in the same Render private network can call it. Add a shared bearer token if the network is shared. |
| T | Hostile image (decompression bomb, wrong type) | Type allow-list, per-file 10 MB and request 40 MB limits, 40 megapixel cap, body-size middleware that rejects early (`main.py`, `config.py`, `imageio.py`). |
| T | Model coaxed into a wrong finding by text in a photo | System prompt treats image text as data; output is enumerated JSON schema; size needs two independent reads (model and OCR) to be `sure`; colour uses no model; `mismatch` needs a `sure` disagreement; `match` needs all three required modules (`fusion.py`). A hostile photo can push toward `unsure` or one wrong module. Whether that is enough is not measured: there is no published vision benchmark in `evals/results/`. |
| T | Buyer submits photos of a different item to force a mismatch | **Open.** Photos are buyer-supplied; the pipeline checks the item against the listing, not that the photo shows the buyer's parcel. EXIF capture time is kept but not used for any decision. A dishonest buyer can void a held payment (section 5). Mitigations that would help: seller-side evidence step, return-first before void, capture time and device checks. |
| R | Verdict cannot be reproduced | Module outputs and timings are stored in `verifications.moduleOutputs` and are in the evidence manifest's verdict; thresholds carry a version string. |
| I | Photos retained or leaked | The service stores nothing (`services/vision/README.md`). Images sent to the model are re-encoded from decoded pixels with no metadata. Photos are sent to Anthropic when a model key is set. |
| D | Slow or expensive model calls | 30 second client timeout, two retries; module failures become `unknown`. Cost is uncapped (section 12). |
| E | SSRF through `listing_image_urls` | `fetch_listing_image` requires https, resolves the host and refuses non-global addresses, follows at most four redirects and re-checks each, caps size and timeout (`main.py`). Residual: the name is resolved once to check and again by the HTTP client, so a DNS answer that changes between the two is not caught. The web app does not use this parameter; it uploads image bytes instead (section 9). |

## 8. Helper links

Files: `apps/web/src/server/helper.ts`, `apps/web/src/app/api/helper/**`, `apps/web/src/app/helper/[token]/page.tsx`.

| STRIDE | Threat | Control or status |
|---|---|---|
| S | Guessing a link | Token is `id.nonce.MAC` with a 192-bit MAC under `HELPER_LINK_SECRET`; the MAC is checked with `timingSafeEqual`, then the stored HMAC of the token must match (`resolveHelperToken`). |
| T | Forged answer changes payment | The answer is stored and the buyer is notified. It touches no order, case or payment field (`answerHelper`). |
| R | Who answered | The audit entry `helper.answered` records the answer. The helper is not identified; the link is a bearer secret. |
| I | Link forwarded or leaked | The page shows the listing and the buyer's photos only, never amounts, payee or payment ids (`resolveHelperToken` comment and select). Links expire after 48 hours. The page is `noindex`. The token is in the URL path, so it can appear in browser history and proxy logs. `Referrer-Policy: strict-origin-when-cross-origin` keeps the path out of cross-site referrers. The photo route sends `Cache-Control: private, no-store`. |
| I | Revoking a link | **Open.** The page says links "can be cancelled at any time" and `helper_requests.revoked_at` is checked, but no route or UI sets it. Close it with a revoke action on the order page. |
| D | Link brute force or spam | **Open.** No rate limit on `/api/helper/*`. Brute force is not feasible at 192 bits; spamming answers is. A helper can answer once (`already: true` afterwards). |
| E | Helper link used to read other users' photos | The photo route takes the kind from the URL but reads only the photos attached to the verification behind that token (`app/api/helper/[token]/photo/[kind]/route.ts`). |

## 9. SSRF in listing image and URL fetches

Every place the server fetches a URL it did not choose:

| Place | Control or status |
|---|---|
| `listingImage` in `apps/web/src/server/vision.ts` fetches up to three `snapshot.images[].url` values (from the catalog) with a plain `fetch` and an 8 second timeout | **Open.** No scheme check, no private-address check, redirects followed. With the Demo Store catalog the URLs are the app's own. With Channel3 they come from a third party's data. A hostile listing could make the web server request an internal address; the response bytes are forwarded to the vision service, not returned to the attacker, so this is blind SSRF with an image-decoder gate. Close it by routing these fetches through the same guarded fetcher as the vision service, or by passing URLs to the service. |
| Local Demo Store files | Paths under `/demo-store/` are read from `public/`. `URL` parsing normalises dot segments before the prefix check, and encoded slashes stay encoded, so the read stays inside that folder. |
| Vision `listing_image_urls` | Guarded (section 7). |
| MCP `verify_delivery` photo URLs | https only, `redirect: 'error'`, resolves the host and rejects private, loopback, link-local, CGNAT and multicast ranges in IPv4 and IPv6, 10 MB cap, timeout (`apps/mcp/src/tools/delivery.ts`). Same resolve-then-connect gap as the vision service. Listing image https URLs are passed to the vision service, which applies its own guard. |
| `packages/browser` robots.txt fetch | Not called from any app. It does fetch `<origin>/robots.txt` for the given https URL with no private-address check. |
| Deepgram token mint | Fixed URL. |

Traversal in MCP: local Demo Store references must match `^/demo-store/[a-z0-9-]+\.(png|jpe?g|webp)$` before they are joined to `webPublicDir` (`DEMO_STORE_PATH` in `apps/mcp/src/tools/delivery.ts`). The pattern allows no dots in the name part and no slashes after the folder, so `..` cannot occur. There is no test for a traversal attempt; adding one would pin this.

## 10. Evidence and receipts

Files: `packages/evidence/src/*`, `apps/web/src/server/receipts.ts`, `apps/web/src/server/cases.ts`, `scripts/verify-receipt.mjs`.

| STRIDE | Threat | Control or status |
|---|---|---|
| S | Forged receipt or evidence pack | Hash plus HMAC (receipts) and Ed25519 over the hash. The hash is domain-separated (`SIGHTLINE/v1/<domain>`) so a receipt hash cannot be passed off as a manifest hash. Anyone can verify Ed25519 with the published key; `scripts/verify-receipt.mjs` does it offline and can pin the key. |
| T | Tampering with a stored pack or receipt | Pages recompute hash and signature on load. A stored row edited without the key fails. Photos are bound by SHA-256 in the manifest; `verifyManifest` checks supplied bytes. |
| T | Tampering with the audit log | Each row commits to the previous; writers are serialised by an advisory lock. **Open**: no code verifies the chain, there is no external anchor, and a party with database write access can rewrite the whole chain. |
| T | One key for everything | **Open.** `RECEIPT_SIGNING_KEY` is the HMAC key and the seed of the Ed25519 key (domain-separated). Someone who has it can forge both. There is no key id or rotation. The public key is served from the same host as the receipts, so a verifier should pin it from an independent source (`expected_public_key` in the MCP tool; second argument in `verify-receipt.mjs`). The MCP evidence key is a different derivation (`mcp-evidence`). |
| R | Seller disputes what the buyer heard | The pack embeds the readback text exactly, its hash and the cart hash. |
| I | Public receipts and evidence | **Open.** `/receipts/[id]`, `/api/receipts/[id]` and `/evidence/[id]` need no login. Ids carry 60 bits of randomness. A receipt contains the user id, the utterance and the item; an evidence page shows the order, readback and verdict. Photos are not served there (only their hashes). Close it by requiring the owner's session, or a signed expiring link, for non-judge receipts. |
| D | Large packs | Photo size is capped upstream (12 MB per photo in the web app, 10 MB in MCP). |
| E | Model text inside signed evidence | The narrative is signed as written. Signing proves integrity, not truth. The narrative is not grounding-checked (`cases.ts`). **Open**: apply `checkGrounding` or restrict the model to filling a template. |

## 11. Browser reads (store pages)

`packages/browser/src/kernel.ts` is a read-only reader: https only, checks robots.txt, honest user agent, no clicks or forms, 120 second browser session, deletes the session in `finally`. It is not imported by the web app, the MCP server or any route, so it is out of the live attack surface today. If wired in: the page text is untrusted input for the same prompt-injection reasons as listings (section 3), the `robotsAllows` fetch needs the SSRF guard from section 9, and quotes must still pass `verifyQuotes` (verbatim match) before use.

## 12. Cost, rate limits and denial of wallet

What is protected: the Anthropic account, the Deepgram account, PayPal sandbox rate limits, the database and the vision service CPU.

| Route | Cost it can cause | Control or status |
|---|---|---|
| `POST /api/demo/start` | Mints a session for anyone | **Open.** No limit. |
| `POST /api/turn` | A free-text turn can call the model up to twice (query parse, listing answer). The confirmation step calls the fast model | Text is capped at 500 characters; `max_tokens` is capped per call; there is no per-user or per-IP quota. **Open.** |
| `POST /api/orders/[id]/check` | Up to three model calls in the vision service per check, plus 45 seconds of CPU | Photo size and count are capped (12 MB each; three kinds). No quota. **Open.** |
| `POST /api/orders/[id]/money-back` | One streamed `AGENT_MODEL` call (up to 4000 tokens) per request | No quota. **Open.** |
| `POST /api/judge/run` | A full lifecycle: several turns, PayPal sandbox orders, a vision check, an evidence pack, a model call | One run at a time, process-wide (`running` flag in the route). No auth, no per-IP limit. **Open.** |
| `POST /api/voice/token` | Mints a 60 second speech-to-text token for any session | No limit. **Open** (small). |
| `POST /api/webhooks/paypal` | One outbound PayPal verify call per request | Section 6. **Open.** |
| Gate | Real money (sandbox) | Per-order cap, daily cap and orders per hour per user (`BudgetGuard`, `RateLimitGuard`, reservations). Applies per user; with shared personas it is shared too. |

Closing it: an IP and session rate limiter in `proxy.ts` (or at Render's edge), a per-session daily budget for model calls, auth on `/api/judge/run`, and a spend alert on the Anthropic key.

## 13. Data at rest

| Item | Where | Status |
|---|---|---|
| Photos | `blobs.bytes` in Postgres, sanitised JPEG, `owner_id` = user | Stripped of EXIF/GPS before storing (`sanitisePhoto`) and again in the vision service. Not encrypted at application level; relies on the managed database's disk encryption. No retention limit, no delete route. `owner_id` has no foreign key, so deleting a user does not delete their photos. **Open.** |
| Capture time | Not stored from EXIF in the web app (sharp drops it); evidence file time is the verification time (`cases.ts`) | Honest in the manifest: it is when the check ran, not when the photo was taken. |
| Secrets | Environment only. `.env*` is git-ignored except `.env.example` (`.gitignore`); Render secrets are `sync: false` | `server-only` imports keep server env out of client bundles. CI runs a gitleaks scan on every push and pull request with full history (`.github/workflows/ci.yml`). `CLAUDE.md` says gitleaks also runs before commits, but no pre-commit hook is installed in this checkout's `.git/hooks`. **Open** (low): install the hook. `/api/health` returns booleans for which integrations are configured, never values. |
| Secret blast radius | `RECEIPT_SIGNING_KEY` signs everything (section 10). `ANTHROPIC_API_KEY` is on two services. `PAYPAL_CLIENT_SECRET` is sandbox. | No rotation procedure in the repo. |
| Webhook bodies | `webhook_events.raw` | Contains PayPal resource data (order, amounts, payer ids). No redaction or expiry. |
| Conversation | `messages` and `conversations.state` | Full text of what the buyer said, kept indefinitely. |
| Audit and receipts | `audit_log`, `receipts` | By design permanent. Contain user ids and utterances. |
| Backups, encryption in transit | Render managed Postgres and TLS at Render's edge | Not configured in this repo. |
| Response headers | `apps/web/next.config.ts` sets `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy` (camera and microphone self, geolocation none) | **Open**: no Content-Security-Policy, no frame-ancestors, no HSTS from the app. Two inline scripts exist (theme and preferences) and both interpolate only server-generated ids and numbers. |

## 14. MCP server

Files: `apps/mcp/src/*`.

| STRIDE | Threat | Control or status |
|---|---|---|
| S | Unauthenticated callers on HTTP | Optional `MCP_API_KEY` bearer check with constant-time comparison. On loopback without a key, only local Host names are accepted (DNS-rebinding guard). Binding to a non-loopback host without a key prints a warning and runs open (`http.ts`). stdio has no network surface. |
| T | Tool arguments used to move money | None of the six tools calls PayPal. `check_confirmation_phrase` returns `payment_allowed: false` always. |
| T | Caller supplies false listing facts or verdicts | `build_evidence_pack` signs whatever the caller passes. The signature proves the pack is unchanged since signing by this server, not that the facts are true. The tool says the facts came from the caller (`source: 'caller'`) and leaves `cartId` and `cartHash` empty. |
| R | Which key signed | `key_source` says `configured` or `ephemeral`; the public key and fingerprint are returned. |
| I | Server reads local files | `webPublicDir` reads for Demo Store images (section 9). The ephemeral key is held in memory. |
| D | Big payloads | 32 MiB body limit on HTTP; 10 MB per photo; 14 MB base64 per evidence file. No rate limit. **Open** (low, local use). |
| E | Fetching internal URLs | Guarded (section 9). |

## 15. Photo privacy

| Threat | Control |
|---|---|
| GPS and camera serial in uploaded photos | `sanitisePhoto` re-encodes through sharp with no metadata passthrough (`apps/web/src/server/blobs.ts`), so EXIF, GPS and maker notes are dropped before storage and before the bytes leave the web server. The vision service removes the EXIF GPS directory and XMP packets again (`services/vision/app/imageio.py`) and reports per photo whether location data was removed. |
| Photos shown to third parties | Helper sees them only through the 48 hour link. Merchant and evidence pages show hashes, not images. Photos go to Anthropic when a vision model is configured. |
| Face or background content in the photo | **Open.** No detection or blurring. The camera guidance asks for the item and the tag only. |
| Listing images fetched from third parties | Sent on to the vision service, not stored by the web app. |

## Fixed since the first draft of this model

- **Merchant console scope.** Each visitor plays both the shopper and the Demo Store; merchant pages and every `/api/merchant/*` action are scoped to the session's own demo shopper (`requireMerchantScope`, `assertOrderInScope`, `assertCaseInScope` in `apps/web/src/server/merchant.ts`).
- **Rate limits.** Per-IP budgets on the judge run, demo start, check, money back, cases, studio, turn and merchant routes (`apps/web/src/proxy.ts`), plus same-origin enforcement for state-changing API calls.
- **Unknown payment outcomes.** An unanswered saved-PayPal order keeps its budget hold, blocks repeat purchases of the same item with no time limit, and is reconciled by re-sending the same `PayPal-Request-Id` when the buyer returns (`reconcileUnknownOrders` in `apps/web/src/server/payments.ts`). Measured in `evals/duplicates`.
- **Shared demo identities.** Every "Try it" creates a fresh, isolated demo shopper (`ensurePersona` in `apps/web/src/server/personas.ts`).
- **SSRF on listing images.** Only https, public addresses (DNS-resolved, private and link-local ranges refused), no redirects, image content types and an 8 MB cap (`isPublicHttpsUrl` in `apps/web/src/server/vision.ts`).
- **Money back without a check.** `prepareMoneyBack` refuses unless the latest check says mismatch or not sure.
- **Case narrative.** Model text is used only if every amount, size, colour and date it mentions is in the facts; otherwise the template text is sent (`narrativeGrounded` in `apps/web/src/server/cases.ts`).
- **Helper links** can be cancelled from the order page (`/api/orders/[id]/helper/revoke`).

## Known gaps, ranked by risk

1. **Public receipt and evidence pages by id.** Ids are unguessable, but anyone with a link can read them (by design for judges). Fix for production: owner-only or expiring links.
2. **Webhook handling gaps.** Verification calls PayPal on every unauthenticated POST; a failed handler is not retried automatically; no transmission-time freshness check.
3. **Single signing secret, no rotation, no audit-chain anchor.** One leaked `RECEIPT_SIGNING_KEY` forges receipts; the chain is written and checkable but not anchored externally.
4. **Held payments are not followed up on a timer.** A failed capture after a match is not retried automatically; authorization expiry is not watched.
5. **A dishonest buyer controls the photos.** The server needs a non-matching verdict before money back, but the photos come from the buyer; production needs a seller review window and photo provenance.
6. **Photos and conversations have no retention or deletion path** yet.
7. **CSP headers, unauthenticated internal vision service** (private network only on Render), **no pre-commit secret hook** (gitleaks runs in CI).
8. **Background speech can satisfy key 1 text matching.** Measured as a negative result; reduced by push-to-talk and the second key, not removed.
