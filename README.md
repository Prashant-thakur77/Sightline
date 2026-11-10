# Sightline

**Is this the one I paid for?**

Sightline is a voice-first shopping agent for blind and low-vision people. It shops by voice, reads back exactly what you will pay before any money moves, checks the parcel that arrives with your phone camera, and gets your money back through PayPal when the item is wrong.

Tools exist that help blind people find products. Checking what arrived and getting money back is still left to them. That last part is where shopping independence breaks today: 49% of disabled shoppers who needed to return something had problems doing it, and one in seven disabled consumers could not use the retailer's suggested return method ([Which? with RIDC](https://www.which.co.uk/policy-and-insight/article/retailers-and-returns-services-potentially-breaking-law-on-returns-for-disabled-consumers-which-finds-ac8dn1v6s5K7)).

**Live:** https://sightline.prashantthakur.dev (no sign-up; judges start at `/judge`).

All payments run on the **PayPal sandbox**. The app refuses to start if it is pointed anywhere else.

## The 60-second path for judges

| Step | Where | What you see |
|---|---|---|
| 1 | `/judge` | One page: the problem, the path, live integration status and every number. |
| 2 | "Shop as Maya, Speech Viewer on" | The real app with a panel that simulates what a screen reader says and lists every announcement. No sign-up. |
| 3 | "Run the whole lifecycle" | Under a minute: voice request, readback, two-key confirmation, PayPal hold, wrong size shipped, camera check, money back, then Demo Store's own agent answering the case and Maya's agent answering its offer. Every PayPal call is a real sandbox call; shipping and delivery are simulated by the Demo Store controls. Needs PayPal sandbox keys on the server. Below the run, "What the agents did" lists every step with who did it, the tool, whether a model or fixed rules decided, and PayPal's own ids and statuses. |
| 4 | Any receipt link | The page re-checks the receipt's hash and Ed25519 signature on load. `node scripts/verify-receipt.mjs` checks it offline. |
| 5 | `evals/RESULTS.md` | Every number, the script that produced it, its baseline and interval. |

## What it does

1. **Shop by voice.** "I need a navy crew-neck sweater, medium, under forty dollars." You hear at most three options with the facts that matter. If the listing does not say something, you hear "the listing doesn't say", never a guess. Open requests ("a gift for my sister who hikes, under $50", "something warm but not scratchy") go to a shopping agent that searches several ways and says why each pick fits, in words checked against the listing. Ask for size M and you never hear an XL; ask for navy and you never get Navy team gear.
2. **It remembers, if you say yes.** "I'm a medium in sweaters" gets "Shall I remember that?", and later searches say "Using your usual size M." Settings lists everything it remembers, to change or forget; "forget my size" works by voice too. Money questions ("What's on hold?", "How much did I spend this month?", "Did I get my refund?") are answered from your orders and PayPal's records, never estimated, and "buy my usual again" reads the order back at today's price.
3. **Readback before paying.** A template (not the model) reads the item, colour, size, seller, total with tax and shipping, delivery date and return window. Paying needs two independent keys: your words or the Confirm button, and a second check by a separate model call. "Wait" holds it open with no time limit.
4. **Money waits for the check.** For stores that opt in, PayPal only authorizes the payment. The camera check decides: a match captures it. A wrong item goes to the store with the evidence while the money stays on hold; the store accepts the return, which voids the hold, or offers a replacement, and if it doesn't answer in 3 business days the hold is voided anyway. If the store offers to take it back or replace it, the hold keeps a deadline (10 business days for a return); an agreed replacement pays the store a week later. If the buyer never checks, the store is paid a week after delivery, after a reminder. While the money is held, the authorization is reauthorized each time its three-day honour period runs out, inside PayPal's 29 days, and failed captures are retried (`apps/web/src/server/holds.ts`, run every 15 minutes). The buyer is told when the parcel should be at the door and the money is still on hold, and a day before a case deadline what happens at it.
5. **Unboxing check.** The phone camera talks you into frame ("move back a little", "there's a glare") and takes the photos. It compares colour in CIELAB colour space, reads the size tag twice with two different readers, and checks the product and any damage. When it is not sure it says so, and you can ask someone you trust to look through a private, view-only link.
6. **Money back.** "This is wrong" builds a signed evidence pack (order, the readback you heard, the listing as it was, your photos, the check), reads you a two-sentence summary, and only then sends the case to the store with the evidence. For a held payment the money stays on hold until the store takes the item back; for a payment already captured, the store can refund through PayPal from its cases desk.
7. **Agent to agent.** The store has its own agent. It checks the evidence pack's signature, reads the order, its shipping record and the store's policy, and proposes one reply: a replacement, the money back (releasing a hold), part of the price back to keep the item, or the item back first. Code lists the replies the policy allows and computes every amount from the order; the model only picks one and gives reasons, and code drops any reason with an amount, size, colour, date or number the case's facts don't hold. Inside the policy the reply goes out at once; otherwise it waits on the cases desk for staff to send, change or dismiss. The buyer's agent reads the offer and its reasons; accepting still takes two presses. A decline gets one revised offer, then staff take over. Keeping the item for less on a held payment captures only the rest, with `final_capture`, and PayPal releases the part.
8. **What your agent did.** Each order page lists every step from the shopping conversation to PayPal's last word: who did it (you, your agent, the store's agent, store staff, PayPal, your helper, the safety check), the tool, whether a model or fixed rules decided, and PayPal's own ids and statuses, read from the hash-chained audit log.
9. **The store sees every clock.** Demo Store's Schedule page (`/merchant/schedule`) draws each order's PayPal hold, its 3-day honour periods and renewals up to day 29, the day-5 reminder, the day-7 auto-capture (paused while a case is open) and each case's reply and offer deadlines on a Bryntum Scheduler timeline, read from the orders, cases and audit log each time it loads. It is read-only. Enter on a bar opens that order's case, and the same schedule follows as a table for screen readers.

## How PayPal is used

| PayPal capability | How Sightline uses it |
|---|---|
| Orders v2 | Orders are created server-side from the confirmed readback. `custom_id` carries the readback binding hash; `invoice_id` is our order id. |
| `PayPal-Request-Id` | Derived from the cart hash and readback id, so a repeated "yes", a double click or a network retry returns the original order instead of a second charge. |
| JS SDK v6 | First purchase uses the `<paypal-button>` web component and a one-time payment session; the order is created on our server. |
| Vault | The first purchase saves PayPal (`store_in_vault: ON_SUCCESS`); later purchases use the vault id with only the spoken confirmation. |
| Authorize / capture / void | Pay after check: authorize at purchase, capture on a match, void on a wrong item. "Keep it for less" captures part of the authorization with `final_capture: true`, so PayPal releases the rest. |
| Reauthorize | Each time a held authorization's three-day honour period runs out, inside PayPal's 29 days, numbered into the request id. |
| Refunds | Full or part refunds from the cases desk or by the store's agent inside the store's policy. |
| Shipment tracking | Added to the PayPal order by the Demo Store merchant console. |
| Disputes | The cases desk reads a PayPal dispute and can make an offer or accept the claim, each only when the dispute's HATEOAS links allow it. The client in `packages/paypal` also covers listing, multipart evidence upload, escalation and the sandbox simulation endpoints; those run in the spike scripts, not in the app. |
| Webhooks | Signature verified on the raw body, stored once per event id, processed after a fast 200. |

## How AI is used

| Where | Model | Why |
|---|---|---|
| Confirmation, key 2 | Claude Haiku 5.5 | An independent reading of the utterance against the readback. It can only agree or veto; it never sees an amount or a payee field it could change. |
| Free questions about a listing | Claude Opus 5.5 | Answers with citations to listing fields or verbatim quotes, then a grounding guard removes any unsupported claim. |
| Open shopping requests | Claude Haiku 5.5 (tool use) | A tool loop that searches the catalog (several phrasings for a gift), reads and compares listings, asks one question when a request is too vague, and picks up to three options with a reason each. Read-only tools; every line it writes is checked against the listings before it is spoken; it hands buying to the template readback. |
| Unclear requests, when the agent can't finish | Claude Opus 5.5 | Turns a request the grammar cannot parse into search filters. |
| Size tag, product, damage | Claude Opus 5.5 (vision) | One of two independent size-tag reads (the other is OCR); a "sure" size verdict needs both to agree. |
| Case narrative | Claude Opus 5.5 | Written only from the evidence manifest, then grounding-checked; the buyer hears it before anything is sent. |
| Store agent | Claude Opus 5.5 | Picks one of the replies code allows under the store's policy and gives reasons citing the case's facts; code checks each reason, decides whether the reply may go out without staff, and computes every amount. Without a key the store's rules pick, and the proposal says so. |

Model output never moves money. Amounts, payees and confirmations come from frozen listing snapshots, the readback and the payment gate. The gate's eight guards run on every payment and write a signed receipt either way.

## Accessibility

Built screen-reader first: one announcer for every live update (no duplicates), focus moves to what changed, full keyboard map (`?` shows it), voice optional everywhere, high-contrast low-vision mode with text scaling, and no colour-only status (every verdict has a word and a shape). Every page is checked with axe in Playwright on desktop and phone. The Speech Viewer shows sighted people what a screen reader says.

## Privacy

Parcel photos are taken inside people's homes, so they are treated as the most private thing the app stores. Location data is removed before a photo is stored or sent anywhere. Photos are deleted after 30 days, or straight away from Settings ("Delete my photos" or "Delete everything"), unless a money-back case that is still open needs them. Signed receipts and evidence packs keep each photo's SHA-256 fingerprint, not the photo, so they still verify afterwards. Payment records and the audit chain are kept, because refunds depend on them.

## Agentic commerce

`apps/mcp` is an MCP server (stdio and Streamable HTTP) so any shopping agent can use the accessible readback, the confirmation phrase check, delivery verification and signed evidence packs:

```bash
claude mcp add sightline -- pnpm --silent --dir /path/to/repo --filter @sightline/mcp stdio
```

## Numbers

Every number is produced by a script in `evals/`, written to `evals/results/*.json`, rendered into `evals/RESULTS.md` and the table below, and read by `/judge` on each page load.

<!-- numbers:start -->
Generated by `evals/report.ts` from `evals/results/*.json`. The last column says how each was measured; rows marked "sandbox ledger" were counted from the PayPal sandbox's own order and authorization records, and no other row comes from PayPal. Full table, intervals and limitations: [evals/RESULTS.md](evals/RESULTS.md).

| Measure | Result | Baseline | How measured |
| --- | --- | --- | --- |
| Live model finishes with the right tool | 8 of 8 | — | live model · `agent-live` |
| Model lines the grounding check stopped before speech | 1 of 14 | — | live model · `agent-live` |
| Wrong model moves the loop refuses (made-up id, unsaid filter or memory, unasked readback) | 7 of 7 | no checks: 0 of 7 | simulated, offline · `agent` |
| Agent lines with a claim the listing does not make, stopped before speech | 2 of 2 | no check: 0 of 2 | simulated, offline · `agent` |
| Top-three listings that name their colour (negative result) | 11 of 21 | Channel3's own top 3: 7 of 21 | simulated, offline · `agent` |
| Median axe-core violations per product page (distinct WCAG A/AA rules failed) | 4 | — | real store pages, read-only crawl · `barrier` |
| Stores where keyboard-only traversal could not reach add to cart within 150 Tabs | 9% (3 of 33) | — | real store pages, read-only crawl · `barrier` |
| False confirms, key-1 phrase matcher, held-out utterances | 0 of 140 | naive keyword match: 82 of 140 | simulated, offline · `confirmation` |
| False confirms, key-1 phrase matcher, 200-utterance development fixture | 0 of 126 | naive keyword match: 50 of 126 | simulated, offline · `confirmation` |
| Intended confirmations the matcher rejects, held-out utterances (negative result) | 35 of 71 (49.3%) | before: 39 of 71 (54.9%); naive: 23 of 71 | simulated, offline · `confirmation` |
| Background speech or misrecognition that yields an exact allowed phrase, with the press rule (negative result) | 3 of 6 confirmed | before: 6 of 6 (text alone); naive: 5 of 6 | simulated, offline · `confirmation` |
| Scenarios that end with more than one PayPal order or authorization (100 duplicate-prone scenarios, sandbox ledger) | 0 of 100 | local simulation: 0 of 100 | sandbox ledger, counted from PayPal sandbox records · `duplicates-sandbox` |
| Lost PayPal answer (dropped after PayPal answered), then a resend or a new readback: scenarios with a second PayPal order (sandbox ledger) | 0 of 20 | before the fix, same id: 10 of 20 | sandbox ledger, counted from PayPal sandbox records · `duplicates-sandbox` |
| Same lost-answer scenarios before the fix (hold released, buyer told nothing was charged), sandbox ledger (negative result) | 10 of 20 | random request id per attempt: 20 of 20 | sandbox ledger, counted from PayPal sandbox records · `duplicates-sandbox` |
| Scenarios that end with more than one PayPal order (100 duplicate-prone scenarios, current payment policy) | 0 of 100 | random request id per attempt: 0 of 100 | simulated, offline · `duplicates` |
| Same 100 scenarios before the fix (lost PayPal answer released the hold and the buyer heard "nothing was charged") (negative result) | 10 of 100 | random request id per attempt: 20 of 100 | simulated, offline · `duplicates` |
| Same probe before the unknown-outcome block (hold kept, duplicate check looks back 10 minutes only) (negative result) | 10 of 10 | random request id per attempt: 10 of 10 | simulated, offline · `duplicates` |
| Answers with one invented claim that the grounding guard catches | 68 of 75 (90.7%) | before: 62 of 75; no guard: 0 of 75 | simulated, offline · `grounding` |
| Fully supported answers the guard wrongly blocks | 0 of 75 | before: 0 of 75; no guard: 0 of 75 | simulated, offline · `grounding` |
| Weakest category: invented return window (negative result) | 10 of 12 caught | no guard: 0 of 12 | simulated, offline · `grounding` |
| Held-out split: unsupported answers caught (negative result) | 29 of 32 | before: 13 of 32 | simulated, offline · `grounding` |
| Payment breaches across 60 adversarial listings, Sightline flow (sandbox ledger) | 0 of 60 | naive policy, local simulation: 50 of 60 | sandbox ledger, counted from PayPal sandbox records · `redteam-sandbox` |
| Injected amount, payee and quantity forced into the payment intent: PayPal orders created (sandbox ledger) | 0 of 60 | — | sandbox ledger, counted from PayPal sandbox records · `redteam-sandbox` |
| Payment breaches across 60 adversarial listings, Sightline flow | 0 of 60 | naive agent policy: 50 of 60 | simulated, offline · `redteam` |
| Breaches when the injected amount, payee and quantity are forced into the payment intent | 0 of 60 | naive agent policy: 50 of 60 | simulated, offline · `redteam` |
| Two looks before "sure": mismatches flagged on the frozen test split (negative result) | 81 of 210 (38.6%) | current rule: 121 of 210 | simulated, offline · `sightbench-looks` |
| Two looks before "sure": matching items wrongly called a mismatch | 2 of 210 (1.0%) | current rule: 4 of 210 | simulated, offline · `sightbench-looks` |
| Quoted reads (with two looks): mismatches flagged / false alarms (negative result) | 66/210 · 1/210 | same pairs, current reads: 81/210 · 2/210 | simulated, offline · `sightbench-looks` |
| Colour mismatches caught: current / two looks / quoted / after one SIMULATED retake (negative result) | 2/53 · 0/53 · 0/53 · 2/53 | — | simulated, offline · `sightbench-looks` |
| Mismatches flagged on the frozen test split, Sightline (negative result) | 66 of 210 (31.4%) | CLIP ViT-B/32, dev-fitted: 194 of 210 (92.4%) | offline benchmark, synthetic photos · `sightbench` |
| Matching items wrongly called a mismatch (false alarms), Sightline | 1 of 210 (0.5%) | CLIP: 189 of 210 (90.0%) | offline benchmark, synthetic photos · `sightbench` |
| False-alarm twin of the secondary metric: matching items called a mismatch or given any disagreeing reason (negative result) | 55 of 210 (26.2%) | first test run (unfitted): 45 of 210 | offline benchmark, synthetic photos · `sightbench` |
| Before two looks and quoted reads (run 4, 2026-11-09): mismatches flagged / false alarms / not sure / accuracy when answering (negative result) | 121/210 · 4/210 · 283/420 · 132/137 | this run: 66/210 · 1/210 · 335/420 | offline benchmark, synthetic photos · `sightbench` |
| Navy delivered for black (or black for navy) in dim light: mismatches caught by Sightline (negative result) | 0 of 7 | in daylight: 0 of 7; CLIP dim: 7 of 7 | offline benchmark, synthetic photos · `sightbench` |
| Different model or damage marks: caught by Sightline (negative result) | model 10 of 52, damage 12 of 52 | CLIP: model 52 of 52, damage 48 of 52 | offline benchmark, synthetic photos · `sightbench` |
| Colour check gave up ("heavy colour cast") on wood tables and plank floors (negative result) | 109 of 113 | other surfaces: 42 of 307 | offline benchmark, synthetic photos · `sightbench` |
| Store-agent replies offered or auto-sent outside the store policy | 0 of 370 | model picks any reply: 30 of 100 not allowed | simulated, offline · `store-agent` |
| Invented facts in store-agent reasons that reach the buyer | 0 of 218 | no check: 218 of 218 | simulated, offline · `store-agent` |
<!-- numbers:end -->

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
cp .env.example .env.local        # every key is explained in the file; generate the secrets with openssl
pnpm db:up && pnpm db:migrate
(cd services/vision && uv run uvicorn app.main:app --port 8011) &
pnpm dev                          # http://localhost:3100
```

Keys and what they switch on (details in `.env.example`):

| Key | Where to get it | Without it |
|---|---|---|
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_MERCHANT_ID` | developer.paypal.com → Apps & Credentials → Sandbox (free) | You can shop, hear the readback and confirm, but nothing is bought: the app says PayPal isn't connected. |
| `ANTHROPIC_API_KEY` | console.anthropic.com | The shopping agent is off (open requests use the grammar), questions about a listing and the second confirmation key are off (two Confirm presses stand in), and the camera check has one size reader, so it says "not sure" instead of "doesn't match". |
| `DEMO_VAULT_ID` | `packages/paypal/spikes/run.ts s2-vault` with a sandbox buyer | The first purchase opens the PayPal window; later ones still need it. |
| `PAYPAL_WEBHOOK_ID` | Create a webhook for `<APP_URL>/api/webhooks/paypal` (public URL only) | Payments still work; updates PayPal sends later (refunds, disputes) are not received. |

Missing keys switch features off honestly: the app says what is not connected instead of faking it. `/judge` lists what is connected on the server you are using.

Tests: `pnpm check` (types, lint, unit tests) and `pnpm check:full` (adds Playwright end-to-end tests with axe on every flow).

## Production

One AWS EC2 host runs Postgres, the vision service, the web app (Next.js standalone image) and Caddy for HTTPS (`deploy/aws`). Migrations run as a one-off job, a cron entry calls the maintenance endpoint every 15 minutes, and PayPal webhooks are registered for the public address. Secrets live only in the host's `deploy/aws/.env`.

```bash
cd deploy/aws && docker compose build && docker compose run --rm migrate && docker compose up -d
```

## What's next

- Sessions with blind and low-vision testers.
- A browser companion that reads any store's product page aloud (colour, size, price and return window, and "the listing doesn't say" when something is missing) and hands the purchase to Sightline at stores that offer pay after check.
- A better colour check, Hindi voice and readback, and a phone line.

## What we do not claim

- It has not yet been tested with blind users. That is the next step.
- Opening a PayPal case on a buyer's behalf by API is a sandbox capability; in production buyers file in PayPal's Resolution Center. We show how an accessible path could work.
- Orders are placed with a sandbox Demo Store at the listed price, not with the real retailer.
- Colour in dim light is unreliable; we publish that error rate and the app says "not sure" instead of guessing.
- Maya and Raj are demo personas, not customers.

## Licence

MIT © 2026 Prashant Thakur
