# Demo video script (2:55)

**Title:** Is this the one I paid for?
**Promise in one line:** independence doesn't end at checkout.

Rules for the cut: every number on screen comes from `evals/RESULTS.md` on the commit you record; real sandbox runs only (no mock screens); the screen reader is audible in shopping and checking; Maya is introduced as a persona; nothing claims user testing that did not happen.

Voice: a calm narrator (AI voice is allowed) plus the app's spoken output. The app's lines are spoken by a screen reader or the app's own voice, captioned word for word (the Speech Viewer panel shows the same words).

---

## 0:00–0:15 Cold open: the doorbell

| Picture | Sound | On screen text |
|---|---|---|
| Black screen. | Fast screen-reader speech reading a cluttered store page: "button. button. unlabelled image. link, image 3 of 12. button." | — |
| Hands open a parcel; a dark sweater. Close on fingers on the knit. | Doorbell, tape tearing. | "95.9% of the top million home pages have accessibility failures. (WebAIM Million 2026)" |
| Hands find the size tag; can't read it. | Narrator: "Maya paid for a navy sweater, size medium. Is this it? She can't see the colour. The tag is just a bump of fabric." | "Maya is a persona. This demo runs on the PayPal sandbox." |

## 0:15–0:45 The check (the hero)

| Picture | Sound | On screen text |
|---|---|---|
| Phone camera page, `/app/check/<order>`: viewfinder with yellow corners. | App: "Move the phone back a little." … "Hold still, capturing." (earcon + vibration) | "Spoken framing guidance. Auto-capture." |
| Size-tag shot. | App: "Got it. Next: the size tag." | — |
| Review screen: "I'll send 2 photos… location data is removed first." Press Check it now. | — | — |
| Verdict page: ✕ Does not match. Two figures: listing vs photo. Table of checks. | App: "This doesn't match. The size tag reads L, you ordered M. I'm sure about that. The colour looks charcoal, not navy." | "Two independent size-tag reads must agree before it says 'sure'." |

## 0:45–1:15 Money waits for the check

| Picture | Sound | On screen text |
|---|---|---|
| Order page, folder "Paid": "On hold with PayPal. Demo Store is paid only after your check matches." | Narrator: "Maya's money never left. With stores that opt in, PayPal only authorized the payment." | "PayPal Orders v2: AUTHORIZE at purchase." |
| Money back folder → "Get my money back" → summary. | App: "The Harbor knit crew-neck sweater that arrived does not match what you ordered… I'll cancel the payment hold." | — |
| Press "Send it". Result line. | App: "Done. I cancelled the payment hold with PayPal. Demo Store was never paid." (paid earcon) | "PayPal Payments v2: void authorization." |
| Evidence page with ✓ Fingerprint matches, ✓ Signature valid. | Narrator: "Every step is signed. Anyone can check it offline." | "Ed25519-signed evidence pack." |

## 1:15–1:50 Rewind: how it was bought (keep it short)

| Picture | Sound | On screen text |
|---|---|---|
| Screen fades to black; only the Speech Viewer panel and captions remain. | Maya (typed or spoken): "I need a navy crew-neck sweater, medium, under forty dollars." App reads three options. | "Screen hidden: this is what a screen reader user hears. (Simulation)" |
| Screen back: options card → "Buy this". Readback ticket prints. | App reads the readback: "Here's what you're buying… total $36.72… To pay, say 'confirm purchase'." | "The readback is a template, never AI text." |
| Maya: "confirm purchase". | App: "Paid on hold…" | "Two keys: her words + an independent model check. The PayPal request id is bound to the readback: no double charge." |

## 1:50–2:15 The other side: Demo Store and PayPal

| Picture | Sound | On screen text |
|---|---|---|
| Merchant console (AG Grid): demo controls "Ship the wrong size (L)". Tracking added. | Narrator: "For the demo we also play the store: it ships the wrong size on purpose." | "Demo controls simulate shipping." |
| Cases desk with the evidence and a suggested fair response; Refund in full. | Narrator: "For a payment that was already captured, the case goes to the seller with the evidence, and PayPal refunds through the API." | "PayPal Refunds, Disputes and verified webhooks." |

## 2:15–2:40 Numbers (from evals/RESULTS.md on this commit)

One card per line, each with its baseline and a link to the script:

- Payment breaches across 60 adversarial listings: **0 of 60** (naive agent: 50 of 60).
- False confirmations on 266 spoken phrases: **0** (keyword matcher: 132).
- Repeat confirmations ending in a second order: **0 of 100** (10 of 100 before our lost-response fix).
- Grounding guard: catches **62 of 75** invented claims; never blocks a true answer (0 of 75).
- SightBench and Barrier Index headlines (fill from RESULTS.md when those suites have run).
- **Negative result we publish:** "It doesn't come in navy" slips past the grounding guard; dim-light navy vs black is hard, so the app says "not sure".

## 2:40–2:55 Close

| Picture | Sound | On screen text |
|---|---|---|
| Hands fold the sweater back into the parcel. | Narrator: "Blind shoppers already do the hard part: getting through the store. Sightline makes sure they only pay for what they actually got." | "Independence doesn't end at checkout." |
| Logo (braille cell + wordmark), judge URL. | — | "Try it: <APP_URL>/judge · Not yet tested with blind users: that's next." |

---

## Capture checklist

- Record at 1920×1080, 60 fps, Chrome with the Speech Viewer on (`/judge` → "Shop as Maya, Speech Viewer on").
- Screen reader audio: NVDA (Windows) or VoiceOver (Mac) captured with system audio; or turn on the app's own voice in Settings for a consistent voice.
- Use the real props (navy M sweater listing; black L sweater delivered) for the camera shots on a phone; a desktop capture of the same flow with the demo parcel photos is the fallback.
- Run the lifecycle on `/judge` once before recording so the sandbox, webhooks and vault are warm.
- Captions: burn in the app's spoken lines; keep the narrator captioned too.
- No music with lyrics; a quiet original bed or none.
