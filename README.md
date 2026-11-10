# Sightline

**Is this the one I paid for?**

Sightline is a voice-first shopping agent for blind and low-vision people. It shops by voice, reads back exactly what you will pay before any money moves, checks the parcel that arrives with your phone camera, and gets your money back through PayPal when the item is wrong.

Tools exist that help blind people find products. Checking what arrived and getting money back is still left to them. That last part is where shopping independence breaks today: 49% of disabled shoppers who needed to return something had problems doing it, and one in seven of those could not use the retailer's return method ([Which? with RIDC](https://www.which.co.uk/policy-and-insight/article/retailers-and-returns-services-potentially-breaking-law-on-returns-for-disabled-consumers-which-finds-ac8dn1v6s5K7)).

**Live:** https://sightline.prashantthakur.dev (no sign-up; judges start at `/judge`).

All payments run on the **PayPal sandbox**. The app refuses to start if it is pointed anywhere else.

## The 60-second path for judges

| Step | Where | What you see |
|---|---|---|
| 1 | `/judge` | One page: the problem, the path, live integration status and every number. |
| 2 | "Shop as Maya, Speech Viewer on" | The real app with a panel that simulates what a screen reader says and lists every announcement. No sign-up. |
| 3 | "Run the whole lifecycle" | About two minutes: voice request, readback, two-key confirmation, PayPal hold, wrong size shipped, camera check, money back, then Demo Store's own agent answering the case and Maya's agent answering its offer. Every PayPal call is a real sandbox call; shipping and delivery are simulated by the Demo Store controls. Needs PayPal sandbox keys on the server. Below the run, "What the agents did" lists every step with who did it, the tool, whether a model or fixed rules decided, and PayPal's own ids and statuses. |
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

## What we do not claim

- It has not yet been tested with blind users. That is the next step.
- Opening a PayPal case on a buyer's behalf by API is a sandbox capability; in production buyers file in PayPal's Resolution Center. We show how an accessible path could work.
- Orders are placed with a sandbox Demo Store at the listed price, not with the real retailer.
- Colour in dim light is unreliable; we publish that error rate and the app says "not sure" instead of guessing.
- Maya and Raj are demo personas, not customers.

## Licence

MIT © 2026 Prashant Thakur
