# Demo video script (2:55)

**Title:** Is this the one I paid for?
**Promise in one line:** PayPal holds the money until your phone confirms the parcel is what you paid for.

Rules for the cut: every number on screen comes from `evals/RESULTS.md` on the commit you record; real sandbox runs only (no mock screens); the screen reader is audible in shopping and checking; Maya is introduced as a persona; nothing claims user testing that did not happen. Record only after the PayPal sandbox keys and the vision model key are set, and the `/judge` lifecycle run has passed.

Voice: a calm narrator (an AI voice is allowed) plus the app's spoken output. The app's lines are spoken by a screen reader or the app's own voice and captioned word for word.

---

## 0:00–0:20 Cold open: the doorbell, then the answer

| Picture | Sound | On screen text |
|---|---|---|
| Black screen. | Fast screen-reader speech; a doorbell; tape tearing. | — |
| Hands open a parcel; a dark sweater. Fingers find the size tag, a bump of fabric. | Narrator: "Maya paid for a navy sweater, size medium. Is this it? She can't see the colour, and the tag is just a bump of fabric." | Lower third: "Maya is a persona. PayPal sandbox." |
| The phone over the sweater, `/app/check/<order>`. | App: "Move the phone back a little… Hold still." (earcon) | — |
| Verdict screen. | App (by 0:15): "This doesn't match. The size tag reads L, you ordered M. I'm sure about that." | "Two independent size-tag reads agree." |

## 0:20–0:40 Why this matters

| Picture | Sound | On screen text |
|---|---|---|
| Plain text cards over the parcel. | Narrator: "Blind shoppers can already get through a store, slowly. What breaks is after the parcel arrives: checking it, and getting money back." | "49% of disabled shoppers who needed to return something had problems doing it. 1 in 7 couldn't use the retailer's return method at all. (Which? with RIDC)" |

## 0:40–1:25 Money waits for the check

| Picture | Sound | On screen text |
|---|---|---|
| Order page, "Paid" folder: "On hold with PayPal." | Narrator: "Maya's money never left. PayPal only authorized it at purchase." | "PayPal Orders v2: AUTHORIZE at purchase." |
| Money back folder → "Get my money back" → summary → "Send it to Demo Store". | App: "I sent your case to Demo Store with the evidence. Your $36.72 stays on hold, so Demo Store can't take it." | "The store sees the evidence first." |
| Demo Store cases desk: the case, the evidence, "Accept the return and release the hold". | Narrator: "The store agrees. PayPal cancels the hold." App on Maya's phone: "Demo Store released the payment hold of $36.72. You were never charged." (paid earcon) | "PayPal Payments v2: void authorization. No answer in 3 business days? The hold is cancelled anyway." |
| PayPal sandbox dashboard: the authorization, status Voided. | — | The real authorization id from the run. |
| Evidence page: ✓ Fingerprint matches, ✓ Signature valid. | Narrator: "Every step is signed. Anyone can check it offline." | "Ed25519-signed evidence pack." |

## 1:25–1:45 How she bought it (keep it short)

| Picture | Sound | On screen text |
|---|---|---|
| Screen hidden; only the Speech Viewer and captions. | Maya: "I need a navy crew-neck sweater, medium, under forty dollars." The app reads three options, then the readback: "…total $36.72… PayPal holds the money, and Demo Store is paid after you check the parcel. To pay, say 'confirm purchase'." | "The readback is a template, never AI text. Paying needs her words and a second, independent check." |

## 1:45–2:15 The other side: fair to the store too

| Picture | Sound | On screen text |
|---|---|---|
| Demo Store console: tracking on the PayPal order after capture; the analytics ticket. | Narrator: "Stores that opt in see fewer 'not as described' disputes. The buyer checks before paying, the store sees the evidence before anything is released, and if nobody checks, the store is paid a week after delivery." | "Pay after check: captures on a match; voids only after the store agrees or doesn't answer." |

## 2:15–2:40 Numbers (from evals/RESULTS.md on this commit)

One card per line, each with its baseline:

- The camera check on SightBench with the vision model: wrong items caught and false alarms, against the CLIP baseline (fill from RESULTS.md after the `--with-model` run; if it is weak, say so).
- "$0 left Maya's account": the voided authorization id from the sandbox run.
- One gate number: false confirmations on 266 spoken phrases: **0** (keyword matcher: 132).
- **Negative result we publish:** dim-light navy vs black is hard, so the app says "not sure" and offers a helper.

## 2:40–2:55 Close

| Picture | Sound | On screen text |
|---|---|---|
| Hands fold the sweater back into the parcel. | Narrator: "Blind shoppers already do the hard part. Sightline makes sure they only pay for what they actually got." | "Independence doesn't end at checkout." |
| Logo (braille cell + wordmark), judge URL. | — | "Try it: <APP_URL>/judge · Not yet tested with blind users: that's next." |

---

## Capture checklist

- Record at 1920×1080, 60 fps, Chrome with the Speech Viewer on (`/judge` → "Shop as Maya, Speech Viewer on").
- Screen reader audio: NVDA (Windows) or VoiceOver (Mac) captured with system audio; or turn on the app's own voice in Settings for a consistent voice.
- Use real props for the camera shots (a navy M listing; a black L sweater delivered) on a phone; the demo parcel photos are the fallback.
- Run the lifecycle on `/judge` once before recording so the sandbox, webhooks and vault are warm; keep its PayPal ids for the dashboard shot.
- Captions: burn in the app's spoken lines; caption the narrator too.
- No music with lyrics; a quiet original bed or none.
