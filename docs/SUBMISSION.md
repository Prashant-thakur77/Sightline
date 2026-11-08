# Sightline: Devpost submission (draft)

Fill the bracketed numbers from `evals/RESULTS.md` on the final commit. Every number below must match that file.

## Tagline

A voice-first shopping agent for blind and low-vision people that checks the parcel before PayPal pays the store, and gets the money back when it's wrong.

## Inspiration

Blind people can already shop online with a screen reader, slowly. The part that still breaks is after checkout. A parcel arrives, and the only way to know if it's the navy medium you paid for, and not a black large, is to ask someone. Getting money back is worse: 49% of disabled shoppers who needed to return something had problems doing it, and one in seven of them couldn't use the retailer's return method at all (Which? with RIDC). A 2026 study of blind shoppers using an AI shopping agent left payment, delivery checks and returns out of scope entirely.

We wanted the whole money lifecycle to be something a blind person can do alone, with PayPal underneath it.

## What it does

1. **Shop by voice.** At most three options at a time, each with colour, size, price and returns. If the listing doesn't say something, it says "the listing doesn't say".
2. **Hear exactly what you pay for.** A template, not the AI, reads the item, colour, size, seller, total with tax and shipping, delivery date and return window. Paying needs two independent keys: your words (or the Confirm button) and a separate model check. "Wait" holds it open with no time limit.
3. **Money waits for the check.** For stores that opt in, PayPal only authorizes the payment at purchase.
4. **Check the parcel with your phone.** The camera talks you into frame and takes the photos. It compares colour in CIELAB colour space against the listing photo, reads the size tag twice with two different readers, and checks the product and any damage. It says "not sure" rather than guess, and can ask someone you trust to look through a private, view-only link.
5. **Get your money back.** A match captures the payment. A wrong item voids the hold, so the money never left. For payments already captured, a signed evidence pack goes to the seller, who can refund through PayPal from the cases desk; every update is read aloud.

## How we built it

**PayPal**
- **Orders v2** with server-side order creation from the confirmed readback; `custom_id` carries the readback binding hash.
- **`PayPal-Request-Id`** derived from the cart hash and readback id, so a repeated "yes", a double click or a network retry returns the original order.
- **JS SDK v6** web component and one-time payment session for the first purchase, with **Vault** (`store_in_vault`) so later purchases need only the spoken confirmation.
- **Payments v2 authorize, capture and void** for pay after check; **Refunds** from the merchant cases desk.
- **Shipment tracking** on the order from the merchant console.
- **Disputes API** (merchant side gated on HATEOAS links and allowed response options; sandbox simulation endpoints).
- **Webhooks** verified on the raw body, stored once per event id, processed after a fast 200.

**AI**
- **Claude Haiku 5.5** as the second confirmation key: an independent reading of what you said against the readback. It can only agree or veto.
- **Claude Opus 5.5** for free questions about a listing (citations to listing fields or verbatim quotes, then a grounding guard removes unsupported claims), for unclear requests, for reading the size tag, product and damage in photos, and for drafting case text from the evidence (checked against the facts before use).
- Model output never moves money: amounts, payee and confirmation come from frozen listing snapshots, the readback and an eight-guard payment gate that signs a receipt for every decision.

**Also:** Channel3 product data, an MCP server so other shopping agents can use the accessible readback, delivery check and evidence packs, a read-only cloud page reader on KERNEL, AG Grid and AG Studio for the Demo Store console and dashboards, and Render for hosting.

## Accessibility is the product

One announcer for every live update, focus that moves only when it should, full keyboard control with shortcuts that can't clash with a screen reader, a high-contrast low-vision mode with text scaling, no colour-only status, and no deadline to decide: say "wait" and the order stays open, and a yes that comes much later just hears the order read again. Every page is checked with axe in light, dark and high-contrast themes at phone and desktop widths. The Speech Viewer shows sighted judges what a screen reader says.

## Numbers (from scripts in the repo, with baselines)

- Payment breaches across 60 adversarial listings: **[0 of 60]**, naive agent **[50 of 60]** (local ledger simulation).
- False confirmations on 266 spoken phrases: **[0]**, keyword matcher **[132]**.
- Repeat confirmations ending in a second order: **[0 of 100]**, **[10 of 100]** before we fixed lost PayPal responses.
- Grounding guard: catches **[62 of 75]** invented claims and wrongly blocks **[0 of 75]** true answers.
- SightBench: **[mismatch recall / false alarms vs CLIP baseline]**.
- Checkout Barrier Index: **[headline]** across **[N]** real stores.
- **Negative results we publish:** negated false statements pass the grounding guard; dim-light navy vs black is unreliable, so the app says "not sure".

## Challenges

- Buyer-side dispute creation by API is a limited-release, sandbox-only path. We built the seller and PayPal sides fully, and made the most common case not need a dispute at all: the money waits for the check.
- Saying "nothing was charged" after a lost PayPal response is a lie that leads to double charges. Our duplicate evaluation found it; we now keep the hold, block repeats and reconcile with the same request id.
- Making a camera check say "not sure" instead of guessing, and making that useful.

## What we learned

Accessibility and payment safety pull in the same direction: a readback that a blind person can trust is also a contract the payment gate can enforce.

## What's next

Sessions with blind and low-vision testers (the consent form, task script and SUS questionnaire are in the repo), Hindi voice and readback, a phone line, and a merchant program where stores opt in to pay after check.

## What we do not claim

Not yet tested with blind users. Buyer-side dispute creation by API is sandbox-only. Orders go to a sandbox Demo Store at the listed price. Colour in dim light is unreliable. Maya and Raj are personas.
