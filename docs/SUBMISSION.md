# Sightline: Devpost submission

Every number below is read from `evals/results/*.json` (rendered in `evals/RESULTS.md`). Re-check them against that file on the final commit.

## Tagline

Shopping on your own when you can't see the screen: hear exactly what you pay, let PayPal hold the money, check the parcel with your phone, and get your money back from the store's own agent.

## Live demo

https://sightline.prashantthakur.dev (PayPal sandbox; no sign-up). Judges start at `/judge`: one press runs the whole lifecycle against the PayPal sandbox in about two minutes.

## Inspiration

Blind people can already shop online with a screen reader, slowly. What still breaks is after checkout. A parcel arrives, and the only way to know whether it's the navy medium you paid for, and not a charcoal large, is to ask someone. Getting money back is worse: 49% of disabled shoppers who needed to return something had problems doing it, and one in seven couldn't use the retailer's return method at all (Which? with RIDC). In a CHI 2026 study of 12 blind and low-vision people shopping with an AI agent (Shin et al.), participants couldn't verify what the agent told them and didn't trust it with payment.

So we built the whole money lifecycle to be something a blind person can do alone, with PayPal underneath it, and with an agent that can be checked at every step.

## What it does

1. **Ask.** Talk or type. A Claude shopping agent searches Demo Store and Channel3's live catalogue, reads details, compares, and asks one question when it has to. You hear three options at most, each with colour, size, price and returns. Every line it speaks is checked against the listings first; a claim the listing doesn't make is never said.
2. **It remembers, if you say yes.** "I'm a medium in sweaters" gets "Shall I remember that?" Later: "Using your usual size M." Settings shows everything it remembers; "forget my size" works by voice.
3. **Hear it back.** Before any money moves, a fixed template (not the model) reads the item, colour, size, seller, total, delivery date and return window. Paying takes two independent keys: your words, and a separate model check. Saying yes twice can never charge you twice.
4. **PayPal holds the money.** The payment is an authorization, made with your saved PayPal (Vault), so there's no popup after the first purchase. The store is paid only after your check passes; an unchecked delivery is paid a week later, after a reminder. Holds are reauthorized inside PayPal's 29 days.
5. **Check it.** Your phone talks you into frame and takes the photos: the item, the size tag, any damage. Claude reads the tag and compares the product with what you bought; a second reader (OCR) must agree before it says it's sure. It says "not sure" rather than guess, and you can send a private link to someone you trust.
6. **Get your money back.** Say it's wrong. Your agent builds a signed evidence pack and sends it to the store. The store's own agent checks the signature, then proposes a fix within the store's rules: a replacement, the hold released, part of the price back to keep it, or the item back first. Code computes every amount; the model only picks and explains. You hear the offer and its reasons and answer with two presses. Decline, and it revises once. PayPal then voids the hold, captures part of it, or refunds.
7. **Money questions.** "What's on hold?" "When does it expire?" "Did I get my refund?" Answered from your orders and PayPal's records, never estimated.
8. **What your agent did.** Every order shows each step: who acted (you, your agent, the store's agent, PayPal, the safety check), the tool, whether a model or fixed rules decided, and PayPal's real ids and statuses.
9. **The store sees every clock.** A Bryntum Scheduler timeline shows each held payment's honour periods and renewals up to day 29, the day-5 reminder, the day-7 auto-capture (paused while a case is open), and each case's reply-by and offer deadlines. Enter on a bar opens the case, and the same schedule follows as a table.

## How we built it

**PayPal (all running in the sandbox)**
- Orders v2, created server-side from the confirmed readback; `custom_id` carries the readback's hash and `PayPal-Request-Id` is derived from it, so retries and repeated yeses return the same order.
- Payments v2: authorize at purchase, capture on a match, void on a wrong item, partial capture with `final_capture` to keep it for less, refunds, repeated reauthorization.
- Vault: the first purchase saves PayPal; later purchases pay with the vault id by voice alone.
- JS SDK v6 for the first approval, with a spoken heads-up before PayPal's window opens.
- Package tracking added to the PayPal order; webhooks verified by signature; Disputes read on the store's case desk.

**AI**
- Claude Opus 5.5: the tool-using shopping agent (11 tools, capped and with a deterministic fallback), size-tag, product and damage reads in photos, the case summary, and the store's agent.
- Claude Haiku 5.5: the second confirmation key, which can only agree or veto.
- Model output never moves money: amounts, payees and confirmations come from frozen listing snapshots, the readback and an eight-guard payment gate that signs a receipt for every decision.

**Also:** Channel3 for live product data, AG Studio dashboards for the store with a Claude assistant, Bryntum Scheduler for the store's holds and deadlines, an MCP server so other agents can use the readback and the delivery check, and AWS for hosting.

## Fair to stores

Stores that offer pay-after-check see the evidence before anything is released, and their own agent settles clear cases inside rules they set. A store is never left unpaid by silence.

## Accessibility is the product

One announcer for every live update, focus that moves only when it should, full keyboard control, a high-contrast low-vision mode with text scaling, and no colour-only status. Every page is checked with axe in light, dark and high-contrast themes at phone and desktop widths (0 violations). The Speech Viewer shows sighted judges what a screen reader says.

## Numbers (scripts in the repo, each with a baseline)

- **Camera check** on a frozen 420-pair test set: when it gives an answer it's right **132 of 137** times (CLIP image similarity: 215 of 420). False alarms on matching items: **4 of 210** (CLIP: 189 of 210). It flags 121 of 210 wrong items and says "not sure" on 283 of 420.
- **Payments:** **0 of 60** breaches across adversarial listings (naive agent: 50 of 60); **0 of 100** duplicate orders across retry scenarios (10 of 100 before we fixed lost PayPal answers).
- **Confirmation:** **0 of 140** false confirmations on held-out phrases (keyword matching: 82 of 140).
- **Grounding:** the guard catches **68 of 75** invented claims and wrongly blocks **0 of 75** true answers; on a held-out set written before the date and negation checks, it catches **29 of 32** and wrongly blocks **0 of 32**.
- **Store agent:** **0 of 370** replies outside the store's policy; **0 of 218** invented facts reach the buyer; **0 of 40** vague claims reach the buyer as plain statements.
- **Shopping agent:** **0 of 15** wrong sizes in the top three (Channel3's own ranking: 1 of 15); 7 of 7 wrong model moves refused.
- **Checkout Barrier Index:** in 33% (15 of 45) of sampled real stores, Tab alone couldn't reach "add to cart".
- **Negative results we publish:** colour mismatches are caught only 2 of 53 times; the check abstains on two thirds of pairs; the grounding guard misses 3 of 12 held-out false negations it has no words for, such as "there's no return fee".

## Challenges

- Buyer-side dispute creation by API is limited to approved partners, so we made the common case need no dispute: the money waits for the check.
- Saying "nothing was charged" after a lost PayPal response leads to double charges. Our duplicates eval found it; we now keep the hold, block repeats and reconcile with the same request id.
- Live sandbox runs found that PayPal rejects item image links without a file extension, which blocked every purchase of a Channel3 product. Such images are now left out.

## What we learned

Accessibility and payment safety pull the same way: a readback a blind person can trust is also a contract the payment gate can enforce, and an agent whose every step is shown is one people can check.

## What's next

Sessions with blind and low-vision testers (consent form, task script and SUS questionnaire are in the repo), a better colour check, Hindi voice and readback, a phone line, and a store program for pay after check.

## What we do not claim

Not yet tested with blind users. Orders go to a sandbox Demo Store at the listed price. Colour checks are weak. Maya and Raj are personas.
