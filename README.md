# Sightline

**Is this the one I paid for?**

Sightline is a voice-first shopping agent for blind and low-vision people. It shops by voice, reads back exactly what you will pay before any money moves, checks the parcel that arrives with your phone camera, and gets your money back through PayPal when the item is wrong.

Tools exist that help blind people find products. Checking what arrived and getting money back is still left to them. That last part is where shopping independence breaks today: 49% of disabled shoppers who needed to return something had problems doing it, and one in seven of those could not use the retailer's return method ([Which? with RIDC](https://www.which.co.uk/policy-and-insight/article/retailers-and-returns-services-potentially-breaking-law-on-returns-for-disabled-consumers-which-finds-ac8dn1v6s5K7)).

All payments run on the **PayPal sandbox**. The app refuses to start if it is pointed anywhere else.

## The 60-second path for judges

| Step | Where | What you see |
|---|---|---|
| 1 | `/judge` | One page: the problem, the path, live integration status and every number. |
| 2 | "Shop as Maya, Speech Viewer on" | The real app with a panel that shows, word for word, what a screen reader says. No sign-up. |
| 3 | "Run the whole lifecycle" | Every step on the sandbox in about 90 seconds: voice request, readback, two-key confirmation, PayPal hold, wrong size shipped, camera check, money back. |
| 4 | Any receipt link | The page re-checks the receipt's hash and Ed25519 signature on load. `node scripts/verify-receipt.mjs` checks it offline. |
| 5 | `evals/RESULTS.md` | Every number, the script that produced it, its baseline and interval. |

## What it does

1. **Shop by voice.** "I need a navy crew-neck sweater, medium, under forty dollars." You hear at most three options with the facts that matter. If the listing does not say something, you hear "the listing doesn't say", never a guess.
2. **Readback before paying.** A template (not the model) reads the item, colour, size, seller, total with tax and shipping, delivery date and return window. Paying needs two independent keys: your words or the Confirm button, and a second check by a separate model call. "Wait" holds it open with no time limit.
3. **Money waits for the check.** For stores that opt in, PayPal only authorizes the payment. The camera check decides: a match captures it, a wrong item voids it, and the money never leaves.
4. **Unboxing check.** The phone camera talks you into frame ("move back a little", "there's a glare") and takes the photos. It compares colour in CIELAB colour space, reads the size tag twice with two different readers, and checks the product and any damage. When it is not sure it says so, and you can ask someone you trust to look through a private, view-only link.
5. **Money back.** "This is wrong" builds a signed evidence pack (order, the readback you heard, the listing as it was, your photos, the check), reads you a two-sentence summary, and only then voids the PayPal hold or opens the case with the seller.

## How PayPal is used

| PayPal capability | How Sightline uses it |
|---|---|
| Orders v2 | Orders are created server-side from the confirmed readback. `custom_id` carries the readback binding hash; `invoice_id` is our order id. |
| `PayPal-Request-Id` | Derived from the cart hash and readback id, so a repeated "yes", a double click or a network retry returns the original order instead of a second charge. |
| JS SDK v6 | First purchase uses the `<paypal-button>` web component and a one-time payment session; the order is created on our server. |
| Vault | The first purchase saves PayPal (`store_in_vault: ON_SUCCESS`); later purchases use the vault id with only the spoken confirmation. |
| Authorize / capture / void | Pay after check: authorize at purchase, capture on a match, void on a wrong item. |
| Refunds | Merchant refunds from the cases desk. |
| Shipment tracking | Added to the PayPal order by the Demo Store merchant console. |
| Disputes | Merchant side: list, get, make offer, accept claim, evidence (multipart), escalate, all gated on the dispute's HATEOAS links. Buyer side and sandbox simulation endpoints for the case lifecycle. |
| Webhooks | Signature verified on the raw body, stored once per event id, processed after a fast 200. |

## How AI is used

| Where | Model | Why |
|---|---|---|
| Confirmation, key 2 | Claude Haiku 5.5 | An independent reading of the utterance against the readback. It can only agree or veto; it never sees an amount or a payee field it could change. |
| Free questions about a listing | Claude Opus 5.5 | Answers with citations to listing fields or verbatim quotes, then a grounding guard removes any unsupported claim. |
| Unclear requests | Claude Opus 5.5 | Turns a request the grammar cannot parse into search filters. |
| Size tag, product, damage | Claude Opus 5.5 (vision) | One of two independent size-tag reads (the other is OCR); a "sure" size verdict needs both to agree. |
| Case narrative | Claude Opus 5.5 | Written only from the evidence manifest, then grounding-checked; the buyer hears it before anything is sent. |

Model output never moves money. Amounts, payees and confirmations come from frozen listing snapshots, the readback and the payment gate. The gate's eight guards run on every payment and write a signed receipt either way.

## Accessibility

Built screen-reader first: one announcer for every live update (no duplicates), focus moves to what changed, full keyboard map (`?` shows it), voice optional everywhere, high-contrast low-vision mode with text scaling, and no colour-only status (every verdict has a word and a shape). Every page is checked with axe in Playwright on desktop and phone. The Speech Viewer shows sighted people what a screen reader says.

## Agentic commerce

`apps/mcp` is an MCP server (stdio and Streamable HTTP) so any shopping agent can use the accessible readback, the confirmation phrase check, delivery verification and signed evidence packs:

```bash
claude mcp add sightline -- pnpm --silent --dir /path/to/repo --filter @sightline/mcp stdio
```

## Numbers

Every number is produced by a script in `evals/`, written to `evals/results/*.json`, rendered into `evals/RESULTS.md`, and read by `/judge` on each page load. See [evals/RESULTS.md](evals/RESULTS.md).

## Architecture

```
apps/web        Next.js app: buyer app, camera check, helper page, merchant console, judge page, API routes
apps/mcp        MCP server
services/vision Python service: photo quality, CIELAB colour, OCR, model reads, rule-based fusion
packages/gate   deterministic payment guards, budget holds, signed receipts
packages/paypal typed sandbox-only PayPal REST client
packages/agent  grammar, readback, two-key confirmation, grounding guard, ranking, spoken copy
packages/evidence canonical JSON, domain-separated hashes, hash chain, Ed25519, evidence manifests
packages/catalog Channel3 client and Demo Store catalog
packages/db     Drizzle schema and migrations
evals           every number shown anywhere
```

## Run it yourself

Requirements: Node 22, pnpm, Docker, Python 3.12 with uv.

```bash
pnpm install
cp .env.example .env.local        # fill the PayPal sandbox and API keys you have
pnpm db:up && pnpm db:migrate
(cd services/vision && uv run uvicorn app.main:app --port 8011) &
pnpm dev                          # http://localhost:3100
```

Missing keys switch features off honestly: the app says what is not connected instead of faking it.

Tests: `pnpm check` (types, lint, unit tests) and `pnpm check:full` (adds Playwright end-to-end tests with axe on every flow).

## What we do not claim

- It has not yet been tested with blind users. That is the next step.
- Opening a PayPal case on a buyer's behalf by API is a sandbox capability; in production buyers file in PayPal's Resolution Center. We show how an accessible path could work.
- Orders are placed with a sandbox Demo Store at the listed price, not with the real retailer.
- Colour in dim light is unreliable; we publish that error rate and the app says "not sure" instead of guessing.
- Maya and Raj are demo personas, not customers.
