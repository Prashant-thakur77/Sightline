# Accessibility conformance report

Audited 9 November 2026 against **WCAG 2.2 Level A and AA**, plus three AAA criteria the product aims for (1.4.6 contrast 7:1, 2.2.3 no timing, 2.5.5 targets of 44 px).

**Summary.** Sightline does well on the basics: structure, contrast, focus visibility, keyboard reach, forced colours, reduced motion and confirmation before payment. Automated axe checks found no A or AA violations on any buyer page. Testing by hand first found **2 failures and 14 partial results** at A/AA, two of them high severity in the main voice loop. All but one were fixed on 9 November; each fix is noted in [Known issues](#4-known-issues) next to the original finding. The one left is AG Charts hover tooltips on the two dashboards, which were not checked. The claimed AAA "no timing" (2.2.3) is not met and is reported as Partial. **No session with a real screen reader has been run yet**, so nothing below proves how NVDA, JAWS, VoiceOver or TalkBack behave. See [What was not tested](#what-was-not-tested).

| Level | Pass | Partial | Fail | Not applicable |
| --- | --- | --- | --- | --- |
| A and AA (55 criteria), after fixes | 45 | 1 | 0 | 9 |
| A and AA, as first audited | 30 | 14 | 2 | 9 |
| Claimed AAA (3 criteria), after fixes | 2 | 1 | 0 | 0 |
| Claimed AAA, as first audited | 0 | 2 | 1 | 0 |

**Partial** means the criterion fails in some places but not others, or could not be checked everywhere. The notes say which.

---

## 1. Scope and method

### Pages covered

`/`, `/start`, `/app` (the conversation, including options, details, compare, readback, hold, cancel and help cards), `/app/orders`, `/app/orders/<id>`, `/app/check/<id>` (intro, verdict), `/app/settings`, `/helper/<token>` (expired state; the answer form by code review only), `/judge`, `/barrier-index`, `/barrier-index/dashboard`, `/receipts/<id>`, `/evidence/<id>`, `/merchant`, `/merchant/disputes`, `/merchant/analytics`, and the 404 page.

The audit tested the working tree as it stood during the session. Other work was landing at the same time, including changes to the announcer, conversation, settings, verdict view, merchant grid and order page. Where a file changed during the audit, its notes describe the version on disk at the end. The dev server was unstable during testing: for a while a compile error in `server/push.ts` returned 500 on every API route, and later the server sent a "reloadPage: HMR hash mismatch" message in a loop. To keep pages loaded, the test scripts dropped those reload messages from the HMR socket. That workaround does not affect the app itself.

### Automated checks

| Check | Tool and settings | Coverage |
| --- | --- | --- |
| Rule-based scan | axe-core 4.14 via `@axe-core/playwright`, tags `wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa, best-practice` | Every page above, in light, dark and high-contrast themes, at 375 and 1280 px |
| AAA contrast | axe `wcag2aaa` (color-contrast-enhanced) | The same matrix |
| Keyboard traversal | Playwright 1.65, Chromium 158: Tab through every page, recording each stop's role, name, focus indicator (computed outline and box-shadow), size and whether it is covered | Every page, with the Speech Viewer open and closed |
| Focus not obscured | Bounding-box overlap between each focused element and the Speech Viewer panel | `/app`, `/app/orders`, `/app/settings` at 1280×900, 1024×700 and 800×600 |
| Reflow and zoom | Horizontal overflow and off-screen elements at 320×256 (1280 px at 400%) and 640×450 (200%); root font size at 200% | Every page |
| Text spacing | Injected the 1.4.12 values (line height 1.5, letter spacing 0.12em, word spacing 0.16em, paragraph spacing 2em), then looked for clipped boxes | Every page at 375 and 1280 px |
| Forced colours | `forcedColors: 'active'`: focus outline style per stop, plus screenshots | `/`, `/app`, order, check, settings, merchant |
| Reduced motion | `document.getAnimations()` with and without `prefers-reduced-motion` | `/` |
| Announcer | A MutationObserver on `[data-announcer]` and `window.__announcements` while driving a real conversation by keyboard: greeting, suggestion, Buy, readback, Shift+Enter in the text box, Wait, Cancel, typed request | `/app` with a fresh Maya session |
| Talk button | Talk activated with a bare `click()` (no key or pointer events), then with Enter and Escape | `/app` |
| Virtual screen reader | `@guidepup/virtual-screen-reader` 0.33 transcripts of 7 pages (supplied with the review), plus the in-app Speech Viewer | See section 3 |

### Manual review

Code review of every client component that handles focus, live regions, keys, pointers or time: `components/a11y/*`, `components/conversation/*`, `components/check/*`, `components/orders/*`, `components/shell/*`, `components/merchant/*`, `app/**/page.tsx` for the routes above, `lib/speech-input.ts`, `lib/feedback.ts`, `lib/quality.ts`, `packages/gate/src/guards/readbackBinding.ts`, `server/session.ts`, and `globals.css` (tokens, focus, motion, forced colours, target sizes). Contrast for every token pair was calculated by hand.

### What was not tested

- **Real screen readers.** No sessions have been run yet with NVDA, JAWS or Narrator on Windows, VoiceOver on macOS or iOS, or TalkBack on Android. They are the next step. Until they happen, nothing here is evidence of how a real screen reader speaks, queues or interrupts these pages. Several findings below are marked "confirm with a real screen reader".
- **Other browsers.** Firefox and Safari/WebKit were not tested. Everything above ran in Chromium.
- **Real hardware input.** No real microphone, camera, speech recognition, haptics or switch access was used. Headless Chromium has no microphone, so speech start was exercised but never produced a transcript.
- **Third-party surfaces.** The PayPal checkout popup and its `<paypal-button>`, AG Studio's edit mode, and AG Charts tooltips and keyboard navigation were not assessed.
- **Real 400% zoom and Windows High Contrast.** Viewport sizes stood in for zoom, and forced colours were emulated.
- **Blind and low-vision users.** The product has not been tested with any. The landing and judge pages already say so.

---

## 2. Results by success criterion

Each criterion is linked to its entry in [Known issues](#4-known-issues) where one exists. File paths are relative to `apps/web/src/`.

### Perceivable

| SC | Level | Result | How tested | Notes |
| --- | --- | --- | --- | --- |
| 1.1.1 Non-text Content | A | Pass | axe; manual | Decorative glyphs, the braille mark and the animated hero are `aria-hidden`, and the hero has a full text equivalent in the figcaption (`components/landing/readback-hero.tsx`). Verdict and helper photos have meaningful alt text. AG Studio charts on `/merchant/analytics` and `/barrier-index/dashboard` are canvases named only "chart, 1 series" / "interactive chart"; each now has its data as a captioned table in a "Data for …" disclosure under the dashboard ([L8](#l8), fixed). |
| 1.2.1 Audio-only and Video-only (Prerecorded) | A | Not applicable | Manual | No prerecorded media. "Hear it" speaks text already on the page. |
| 1.2.2 Captions (Prerecorded) | A | Not applicable | Manual | No video. |
| 1.2.3 Audio Description or Media Alternative | A | Not applicable | Manual | No video. |
| 1.2.4 Captions (Live) | AA | Not applicable | Manual | No live media. |
| 1.2.5 Audio Description (Prerecorded) | AA | Not applicable | Manual | No video. |
| 1.3.1 Info and Relationships | A | Pass | axe; virtual SR transcripts; manual | Real tables with captions and `scope` (orders, verdict, compare, judge numbers); `dl` for facts and readback lines; `fieldset`/`legend` in settings; headings in order; landmarks; the moments strip uses `aria-current="step"` with hidden "done / now / not yet" text. The order page's three "Technical details" disclosures now carry the step name, for example "Technical details: Paid". |
| 1.3.2 Meaningful Sequence | A | Pass | Virtual SR transcripts; reflow screenshots | DOM order matches reading order in both the one- and two-column layouts. |
| 1.3.3 Sensory Characteristics | A | Pass | Manual | `app/judge/page.tsx:53` said "The black panel shows…", naming the panel by colour only. It now says "The Speech Viewer panel shows…" ([L14](#l14), fixed). |
| 1.3.4 Orientation | AA | Pass | Manual (CSS, manifest) | No orientation lock. |
| 1.3.5 Identify Input Purpose | AA | Not applicable | Manual | No fields for the input purposes in WCAG section 7 (name, email, address, payment). PayPal collects those. |
| 1.4.1 Use of Color | A | Pass | Manual; forced-colours screenshots | Every status has a word and a shape (✓ ✕ ? !). Body links are underlined. Advisory: in the Speech Viewer, "focus" and "read" lines differ only by border colour; "Announced:" lines also carry a text prefix. **Correction after the audit:** body links were *not* underlined (Tailwind's reset removed it). Links are now underlined by default (`a` in `app/globals.css`); only links styled as buttons or navigation opt out. |
| 1.4.2 Audio Control | A | Pass | Manual (`announcer.tsx`, `app/app/layout.tsx`) | When a persona's voice mode is not "My screen reader" (Raj is "both"), the app's own voice speaks the greeting on load. It can be stopped only with Escape or by changing settings; there is no visible stop control ([M5](#m5)). Earcons are under 1 s. **Fixed:** a visible "Stop speaking" button sits under Talk whenever the app's own voice is on ([M5](#m5)). |
| 1.4.3 Contrast (Minimum) | AA | Pass | axe on all pages × 3 themes × 2 widths; token maths | 0 violations. Ink on paper is 18.98:1. The lowest text pair is 6.87:1. |
| 1.4.4 Resize Text | AA | Pass | 640 px viewport (200% zoom); root font at 200% | No loss of content or function. At 200% root text with a 1280 px viewport, the decorative hero overflows by 65 px on `/` (scrollable, nothing lost). |
| 1.4.5 Images of Text | AA | Pass | Manual | Wordmark and figures are live text. |
| 1.4.10 Reflow | AA | Pass | 320×256 overflow probe | `/` scrolls sideways by 38 px at 320 px: the 14 braille cells in `.rbh-head` force a 342 px column ([M3](#m3)). Every other page reflows. Merchant data tables scroll inside their own container, which is allowed. **Fixed:** the braille row wraps; `/` has no sideways scroll at 320 px ([M3](#m3)). |
| 1.4.11 Non-text Contrast | AA | Pass | Manual (token maths); forced colours | Buttons and inputs have 2.5px ink borders. The focus ring is a 3px ink outline (18.98:1) with a yellow halo, or a white halo in high contrast. Hairlines are used only for decoration. |
| 1.4.12 Text Spacing | AA | Pass | Injected spacing at 375 and 1280 px | No clipped text. The only flags were `.sr-only` and 3 px rounding in AG Grid header cells. |
| 1.4.13 Content on Hover or Focus | AA | Partial | Manual | Sightline's own UI shows nothing on hover or focus. AG Charts hover tooltips on the two dashboards were not checked for dismissal or persistence. |

### Operable

| SC | Level | Result | How tested | Notes |
| --- | --- | --- | --- | --- |
| 2.1.1 Keyboard | A | Pass | Keyboard traversal; synthetic click test | Every Sightline control is reachable and operable with Tab, Enter and Space. **Gaps:** (1) the Talk button ignores a click that arrives without key or pointer events (confirmed in Chromium), which is how some assistive technology activates controls ([H1](#h1)); (2) AG Grid columns can be resized only by dragging (`components/merchant/grid.tsx:127`, [L9](#l9)); (3) the `<pre>` on `/receipts/<id>` scrolls but cannot be focused (axe `scrollable-region-focusable`; Chromium compensates, Safari does not; [L10](#l10)). **Fixed:** (2) column resizing is off, and (3) the command wraps and never scrolls (no overflow at 320 or 1280 px). (1) is fixed too: a bare click toggles listening, and a press under 350 ms keeps listening on ([H1](#h1)). |
| 2.1.2 No Keyboard Trap | A | Pass | Keyboard traversal | Every traversal reached the end of the page, including through AG Grid (one Tab stop in, one out). |
| 2.1.4 Character Key Shortcuts | A | Pass | Code review; announcer test | Single-key shortcuts are off by default and can be turned on in the shortcuts panel or in Settings. When off, shortcuts need Alt+Shift (Option+Shift). They never fire while typing in a field (`components/conversation/conversation.tsx`). |
| 2.2.1 Timing Adjustable | A | Pass | Code review | A readback must be confirmed within 5 minutes (`packages/gate/src/guards/readbackBinding.ts:75`). "Wait, hold on" removes that limit, and when it runs out nothing is lost: the order is read again. **Gap:** sessions end 12 hours after creation with no warning or extension (`server/session.ts:10`), which is under the 20-hour exception ([L15](#l15)). **Fixed:** sessions slide, ending 24 hours after the last visit ([L15](#l15)). The re-read after 5 minutes was promised in the copy but not done; the conductor now reads the order again with a fresh price check (`server/conductor.ts`, tested in `apps/web/test/reread.int.test.ts`). |
| 2.2.2 Pause, Stop, Hide | A | Pass | `getAnimations()` | The hero animation runs once for **5.26 s**, just over the 5 s limit, with no pause control. With reduced motion on, no animations run ([L3](#l3)). The listening and thinking pulses are status indicators that stop with the activity. **Fixed:** the sequence ends by 4.76 s ([L3](#l3)). |
| 2.3.1 Three Flashes or Below Threshold | A | Pass | Manual | Nothing flashes. The 900 ms pulse is a slow fade. |
| 2.4.1 Bypass Blocks | A | Pass | curl on every page | A skip link and `<main id="main">` on every page. The default 404 page had no `#main`; the new `app/not-found.tsx` has one, and only one, including for a missing order inside the buyer area ([L7](#l7), fixed). |
| 2.4.2 Page Titled | A | Pass | `<title>` on every page | Titles are specific. Order pages were all "Order", `/merchant` was "Orders · Sightline", an expired helper link kept "Can you take a look?" and the 404 page used the site default. Now: "<item>, order", "Orders · Demo Store", "Link expired" and "Page not found" ([L7](#l7), fixed). |
| 2.4.3 Focus Order | A | Pass | Keyboard and announcer tests; code review | **Confirmed:** after a suggestion button is used, the suggestions are replaced and focus falls to `<body>` ([H2](#h2)). **Dev build:** `/app/check/<id>` still moves focus to the verdict heading on load, because Strict Mode runs the effect twice ([L6](#l6)). **Code:** controls that are disabled or removed while focused also drop focus to `<body>` (MoneyBack, AskHelper, HelperAnswer, LifecycleRun, JudgeStart, "Check it now"; [L4](#l4)). **Fixed:** L6 and L4 (component tests, including under Strict Mode); H2 remains. **H2 fixed:** if focus was on a suggestion, it goes to the new card heading, else the first new suggestion, else the text box. |
| 2.4.4 Link Purpose (In Context) | A | Pass | Virtual SR transcripts; manual | Repeated "Open the proof" links sit inside named step items. |
| 2.4.5 Multiple Ways | AA | Pass | Manual | Header navigation, orders list, in-page links and voice commands. |
| 2.4.6 Headings and Labels | AA | Pass | Manual; transcripts | Descriptive throughout. Advisory: the Talk button's label ([L13](#l13)). The "Technical details" duplicates (1.3.1) now carry the step name. |
| 2.4.7 Focus Visible | AA | Pass | Computed style at every Tab stop, in normal and forced-colours modes | Every stop had a 3px outline plus a 7px halo. Forced colours keep the 3px outline in the system colour. Focused headings get the ring only for keyboard focus (`:focus-visible`). |
| 2.4.11 Focus Not Obscured (Minimum) | AA | Pass | Overlap probe with the Speech Viewer open | Between 641 px and about 1100 px wide, the fixed panel (440×504 px) covers controls in the bottom-right. At 800×600, focused **Send** and **Why these?** are completely hidden. At 1024 and 1280 px, Talk, Send, Save settings and several settings fields are partly hidden. The panel cannot be dismissed without moving focus ([M1](#m1)). With the viewer closed, nothing is covered. **Fixed:** at 1100 px and wider the page reserves a column for the open panel; narrower, the page gets bottom padding and `scroll-padding-bottom`, so focused controls scroll clear of it. Escape closes the panel when focus is in it. Probe at 800×600: Send, Help and Keyboard shortcuts 0% covered ([M1](#m1)). |
| 2.5.1 Pointer Gestures | A | Pass | Manual | No path-based or multi-touch gestures. Hold-to-talk is a long press, which this criterion does not cover, and it has a keyboard toggle and a text box as alternatives. |
| 2.5.2 Pointer Cancellation | A | Pass | Code review | Listening starts on pointer down but nothing is sent until pointer up, and Escape cancels. Advisory: dragging off the button sends instead of cancelling (`conversation.tsx:277`). |
| 2.5.3 Label in Name | A | Pass | Transcripts; manual | Accessible names begin with the visible text: "Sightline, home", "Refund in full on case…", and "Buy this" (with a description). |
| 2.5.4 Motion Actuation | A | Not applicable | Manual | No motion input. Vibration is output only. |
| 2.5.7 Dragging Movements | AA | Pass | Code review; DOM check of the dashboards | Column resizing in the merchant orders grid worked only by dragging; it is now off, and text wraps instead ([L9](#l9), fixed). AG Studio's grid widgets on the dashboards hide their resize handles in view mode (`display: none`). AG Studio's edit-mode layout dragging is third-party and was not assessed. |
| 2.5.8 Target Size (Minimum) | AA | Pass | Sizes recorded at every Tab stop | Controls are at least 44 px (most 48–72 px). Links of 21–26 px are inline in a sentence or are at least 24 px. |

### Understandable

| SC | Level | Result | How tested | Notes |
| --- | --- | --- | --- | --- |
| 3.1.1 Language of Page | A | Pass | curl | `<html lang="en">` on every page. |
| 3.1.2 Language of Parts | AA | Not applicable | Manual | All content is English. |
| 3.2.1 On Focus | A | Pass | Keyboard traversal | Focus never changes context. The helper link selects its own text on focus, which is not a change of context. |
| 3.2.2 On Input | A | Pass | Manual | The theme select changes only presentation. Settings save only when Save is pressed. |
| 3.2.3 Consistent Navigation | AA | Pass | Manual | The public, buyer and merchant headers are each the same on every page. |
| 3.2.4 Consistent Identification | AA | Pass | Manual | Theme, Speech Viewer and status words are named the same everywhere. |
| 3.2.6 Consistent Help | A | Not applicable | Manual | No help mechanism is repeated across pages: Help exists only inside the conversation. Adding a Help link to the buyer header would be worthwhile. |
| 3.3.1 Error Identification | A | Pass | Code review; conversation test; component tests | Conversation, check and money-back errors are announced in text. Settings now names the field, sets `aria-invalid` and focuses it (`app/app/settings/settings-form.tsx`). If the network failed in AskHelper (ask or cancel) or HelperAnswer, no message appeared and the button stayed busy. Each now shows and announces "Could not reach the server. Nothing changed. Try again." and clears busy ([L5](#l5), fixed). |
| 3.3.2 Labels or Instructions | A | Pass | Manual | Every field has a programmatic label. **Gaps:** the composer's only visible label is its placeholder (the real label is `sr-only`, `conversation.tsx:297–305`; [L12](#l12)). The Talk button's visible label "Hold to talk" does not describe the keyboard behaviour (press once to start, again to send), and the greeting says "Press Talk" ([L13](#l13)). **Fixed:** "Or type what you need" is a visible label; Talk is labelled "Talk" with the description "Hold to talk, or press once to start and again to send." ([L12](#l12), [L13](#l13)). |
| 3.3.3 Error Suggestion | AA | Pass | Code review | Settings errors give the allowed range, for example "most for one order (1 to 5,000 dollars)". Refusals say what to do next. |
| 3.3.4 Error Prevention (Legal, Financial, Data) | AA | Pass | Conversation test; code review | Before paying there is a spoken readback, two-key confirmation, a second press, "Wait, hold on" and Cancel. Shift+Enter cannot confirm from inside the text box (tested). Money back shows a preview and "Not now" before anything is sent. Merchant refunds have a confirm step. |
| 3.3.7 Redundant Entry | A | Pass | Manual | Sizes, limits and the helper are saved and reused. |
| 3.3.8 Accessible Authentication (Minimum) | AA | Pass | Manual | Sightline has no password or cognitive test: demo personas start with one button. The PayPal login is PayPal's own page and was not assessed. |

### Robust

| SC | Level | Result | How tested | Notes |
| --- | --- | --- | --- | --- |
| 4.1.1 Parsing | — | — | — | Removed in WCAG 2.2. |
| 4.1.2 Name, Role, Value | A | Pass | axe; keyboard traversal; synthetic click | Names, roles and states are correct throughout (`aria-pressed`, `aria-expanded`, `aria-current`, `aria-invalid`). **Gaps:** (1) the Speech Viewer transcript `<ol aria-hidden="true">` becomes a Tab stop once it overflows, because Chromium makes scrollable boxes focusable, so focus lands on content hidden from assistive technology (`components/a11y/speech-viewer.tsx:154`). axe does not catch this ([M2](#m2)). (2) The Talk button exposes the button role but ignores the platform's default action, a bare click ([H1](#h1)). **Fixed:** the transcript scrolls in a named, focusable region and the list inside stays hidden ([M2](#m2)); Talk handles a bare click ([H1](#h1)). |
| 4.1.3 Status Messages | AA | Pass | Announcer capture | One live-region pair, present from first paint; each turn was announced exactly once (7 turns, 7 announcements, no duplicates). **Gaps:** the "Thinking…" status (`#convo-status`) is not in a live region ([L11](#l11)). Several flows also say the same thing twice: they focus a result paragraph and announce the same text ([M4](#m4)). **Fixed** for the merchant orders console and case desk (and MoneyBack and HelperAnswer, which do the same): they announce with `live: false`. **Fixed:** a reply slower than 1.5 s announces "Working on it." once ([L11](#l11)); settings and the new data controls announce with `live: false` when focus moves to the same text ([M4](#m4)). `check-flow.tsx` no longer pairs `role="alert"` with an announcement. |

### Claimed AAA criteria

| SC | Result | How tested | Notes |
| --- | --- | --- | --- |
| 1.4.6 Contrast (Enhanced), 7:1 | Pass | axe `wcag2aaa`, every page × theme | One miss: `.muted` text (#4a4a4e) on the Checked folder tint (#e9e3cf) on `/app/orders/<id>` is **6.87:1**: the "(fairly sure)" confidence words and "Confirmed …" ([L1](#l1)). Everything else is at least 7:1 in all three themes. **Fixed:** `--muted` is #3f3f43 in the light theme: 8.16:1 on the Checked tint, 10.1:1 on paper ([L1](#l1)). |
| 2.2.3 No Timing | Partial | Code review | Timing is part of paying: confirm within 5 minutes unless held (`packages/gate/src/gate.ts:31`, `readbackBinding.ts:75`), and sessions last 12 hours (`server/session.ts:10`). Both are non-destructive, but the claim as written is not met ([M6](#m6)). **Changed:** a confirmation more than 5 minutes after the readback now gets the order read again with a fresh price check (one more "confirm purchase"), instead of stopping; "wait" still removes the window; sessions slide to 24 hours after the last visit. Timing still decides whether a yes pays straight away, so this stays Partial and the product no longer claims "no time limits" ([M6](#m6)). |
| 2.5.5 Target Size (Enhanced), 44 px | Pass | Sizes at every Tab stop | Buttons and inputs pass (labels are equivalent targets for the 28 px radios and checkboxes). Standalone text links were 26 px tall: "All orders and money", "Back to your order", "Read the signed evidence pack", the item links in the orders table, and the footer link row. They now use `.link-target` and are 44 px; the footer links were measured at 320 and 1280 px, the rest by code ([L2](#l2), fixed). |

---

## 3. Screen reader experience

### Announcer policy (`components/a11y/announcer.tsx`)

- **One writer.** Only the `AnnouncerProvider` writes to live regions. It renders two visually hidden regions, one `aria-live="polite"` and one `aria-live="assertive"`, both with `aria-atomic="false"` and `aria-relevant="additions"`. They are in the DOM from first paint, so the first message is not lost while a region is being created.
- **Append, never replace.** Each message is added as a new `<p>`, so a screen reader queues it rather than dropping it. Nodes are removed after 5 s. The same text within 1.2 s is dropped.
- **Politeness.** Replies, guidance and confirmations are polite. Errors, refusals, cancellations, money results and camera verdicts are assertive.
- **"One channel" in the conversation.** The reply is announced once, and focus stays where it is unless the control just used has gone. In that case focus moves to the new card's heading, or to the text box. In the keyboard test, Buy moved focus to "Readback: check before you pay" and read the full readback politely. Cancel moved focus to the text box with an assertive "Okay, I won't pay…". Shift+Enter in the text box sent nothing.
- **Repeat and stop.** Alt+Shift+R (or R with single keys) repeats the last reply. Escape stops the app's own voice and cancels listening.
- **App's own voice.** The announcer can also speak through `speechSynthesis`. It is off when voice mode is "My screen reader" (Maya's default) and on for "both" or "own voice" (Raj). A screen reader user who picks "both" will hear everything twice. That is by design, but nothing in settings warns about it.

What this does not yet guarantee:

- **Double speech from focus plus announce.** Settings (on success), the merchant orders console and the merchant case desk focus a result paragraph *and* announce the same text, so it is likely spoken twice ([M4](#m4)). The orders console and case desk now announce with `live: false`, so only the focused paragraph is read.
- **Focus loss in the main loop.** After a suggestion button is used, focus falls to `<body>` ([H2](#h2)).
- **Long replies in a polite region.** The readback (about 60 words) and the compare reply (about 120 words) are spoken from a polite live region. They cannot be reviewed word by word there, and a screen reader may cut them off if the user keeps moving. The same text is available as structure, in the readback card's `dl`, the compare table and the Conversation region, which is focusable and labelled by its heading. Real screen reader sessions need to confirm how well that recovery works.
- **"Hold to talk"** is the visible and accessible name, but by keyboard it toggles. The click-only activation gap ([H1](#h1)) matters most here, because voice is the product.

### Speech Viewer (`components/a11y/speech-viewer.tsx`)

The Speech Viewer is for sighted viewers: judges and helpers. It shows what a screen reader *might* say. It is **not** the output of NVDA, JAWS, VoiceOver or TalkBack. How it works:

- When opened, it runs `@guidepup/virtual-screen-reader` over `#app-root`. Lines marked "focus" and "read" come from that simulation. It builds its own accessibility model from the DOM rather than reading the browser's accessibility tree. It does not model browse versus focus mode, verbosity settings, punctuation levels, or how real screen readers queue and interrupt speech.
- "Announced:" and "Alert:" lines come straight from the announcer's subscribe channel. They show what was *sent* to the live regions, not what a screen reader actually spoke or dropped.
- "Read this page" steps through the simulation line by line, 380 ms apart, up to 400 steps.
- Known differences from real screen readers seen in the transcripts: names are joined without spaces ("Step 1:Asked", "Demo StoreMerchant console") where browsers usually insert one. Treat odd spacing in the viewer as a possible artefact before you treat it as a bug.

Accessibility of the viewer itself: the toggle is a real button with `aria-pressed`, and its state is remembered. The panel is an `<aside aria-label="Speech Viewer">` with a hidden note telling screen reader users to ignore it. The transcript list is `aria-hidden` so real screen reader users don't hear everything twice. Two defects: the hidden list becomes focusable once it overflows ([M2](#m2)), and the fixed panel can completely cover focused controls ([M1](#m1)). It is open by default on the judge path ("Shop as Maya, Speech Viewer on").

### Virtual transcripts

Seven page transcripts produced with the same library were reviewed. They match the structure described in section 2: one h1 per page, named landmarks, labelled tables, and status words next to every glyph. They have the same limits as the Speech Viewer and do not replace real screen reader sessions.

---

## 4. Known issues

Ranked by severity for a blind or low-vision buyer. File paths are relative to `apps/web/src/`.

### High

<a id="h1"></a>**H1. The Talk button ignores a bare click, and a quick tap starts listening then stops at once.** (2.1.1, 4.1.2) `components/conversation/conversation.tsx:267–295` handles only `onPointerDown`, `onPointerUp`, `onPointerLeave` and `onKeyDown`; there is no `onClick`. Confirmed in Chromium: `button.click()` changes nothing. Some assistive technology activates buttons with only a click event, and touch screen readers send a very fast down/up pair, which starts listening and stops it straight away. *Confirm with real NVDA, JAWS, VoiceOver iOS and TalkBack sessions.*
**Fix:** add `onClick={(e) => { if (e.detail === 0) toggleListening(); }}`, where `toggleListening` is the current Enter branch: `speech.listening ? speech.stop() : (setToggleTalk(true), startListening())`. In `onPointerDown`, store `downAt.current = performance.now()`. In `onPointerUp`, if the press lasted less than 350 ms, call `setToggleTalk(true)` and keep listening instead of calling `speech.stop()`.
**Fixed:** Talk now has an `onClick` that toggles listening when the click has no pointer or key events (`detail === 0`); a press under 350 ms starts listening and keeps it on; a second press sends. Probe: `button.click()` announces "Listening.".

<a id="h2"></a>**H2. Focus falls to `<body>` after a suggestion is used.** (2.4.3) Confirmed: Enter on "Navy crew-neck sweater…" replaces the suggestion buttons, and `document.activeElement` becomes `<body>`. `focusWasInCard` (`conversation.tsx:67–69`) covers only controls inside the card.
**Fix:** add `const suggestionsRef = useRef<HTMLDivElement>(null)` on `.suggestions`. Compute `const focusWasInSuggestions = Boolean(suggestionsRef.current?.contains(document.activeElement))` next to `focusWasInCard`, and restore focus when either is true: to the new card's `.card-h`, otherwise the first new suggestion button, otherwise `#say`.
**Fixed:** `suggestionsRef` on `.suggestions`; focus goes to the new card heading, else the first new suggestion, else `#say`, and only if it was lost.

### Medium

<a id="m1"></a>**M1. The Speech Viewer covers focused controls between 641 px and about 1100 px.** (2.4.11, Fail) The panel is `position: fixed` and 440×504 px. At 800×600, Send and "Why these?" are completely hidden when focused.
**Fix:** when the viewer is open, reserve space for it instead of overlaying. In `globals.css`: `@media (min-width: 641px) { #app-root:has(.speech-viewer[data-open='true']) { padding-right: calc(min(440px, 100vw - 1rem) + 2rem); } }`. Also let Escape close the panel without moving focus.
**Fixed:** Reserved column at 1100 px and wider; bottom padding plus `scroll-padding-bottom` below that, because a 440 px column would leave about 170 px for content at 641 px. Escape closes the panel when focus is inside it. Overlap probe at 800×600: 0% covered.

<a id="m2"></a>**M2. The Speech Viewer's hidden transcript becomes a Tab stop.** (4.1.2) `speech-viewer.tsx:154` puts `overflow-y: auto` (`.sv-lines`, `app/globals.css:577`) on an `aria-hidden` list. Once it overflows, Chromium makes it focusable.
**Fix:** move scrolling to a wrapper. Use `<div className="sv-scroll" tabIndex={0} role="region" aria-label="Speech Viewer transcript, a visual copy of what your screen reader says">` containing `<ol className="sv-lines" aria-hidden="true">`, and move `overflow-y: auto` to `.sv-scroll`.
**Fixed:** `.sv-scroll` is a focusable `role="region"` named "Speech Viewer transcript, a visual copy of what your screen reader says"; the list inside stays `aria-hidden`. The panel also no longer copies `live: false` messages, which the virtual screen reader already shows from focus.

<a id="m3"></a>**M3. The landing page scrolls sideways at 320 px.** (1.4.10, Fail) `.rbh-head` is a non-wrapping row of 14 braille cells that is 342 px wide.
**Fix:** in `globals.css`, add `.rbh-head { flex-wrap: wrap; row-gap: 6px; }` and `.rbh-stage { grid-template-columns: minmax(0, 1fr); }`.
**Fixed:** `.rbh-head` wraps and `.rbh-stage` uses `minmax(0, 1fr)`; the ticket header wraps too. No overflow at 320 px.

<a id="m4"></a>**M4. Some results are spoken twice.** (4.1.3, against the product's own policy) These flows focus a result paragraph *and* announce the same text: `app/app/settings/settings-form.tsx:55–58` on success, `components/merchant/orders-console.tsx:129` with `:160/:165`, and `components/merchant/case-desk.tsx:102` with `:177`.
**Fix:** add an option to the announcer, for example `announce(text, { live: false })`, that logs to the Speech Viewer and speaks with the app's own voice but does not write to a live region. Use it wherever focus moves to the same text. Keep the live announcement when focus goes to a different element, such as the invalid field in settings.
**Fixed (merchant orders console and case desk; the settings part is separate):** both announce results with `live: false`, so the text still reaches the Speech Viewer and the app's own voice but not a live region. The orders console keeps the live announcement if a different order is selected by the time the result arrives, because its result is not shown then. In the case desk, a refresh that moves a case from Open to Closed rebuilds its card; focus now goes back to the same result instead of falling to `<body>` (`test/audit-focus.test.tsx`). MoneyBack's result and HelperAnswer's thank-you line follow the same rule (see [L4](#l4)).
**Fixed (settings part):** Settings part: the status line is announced with `live: false` when focus goes to it (and live when focus goes to an invalid field). The new "Your data" controls do the same.

<a id="m5"></a>**M5. The app's own voice plays on load with no visible way to stop it.** (1.4.2) When voice mode is "both" or "own voice", the greeting and every reply are spoken automatically. Only Escape stops it.
**Fix:** in `conversation.tsx`, show a "Stop speaking" button next to Talk while `speechSynthesis.speaking` is true (poll it, or track it from utterance `onstart`/`onend`). It calls `stop()`.
**Fixed:** A "Stop speaking" button appears under Talk whenever the app's own voice is on. It stays while the voice is on, so it never vanishes from under focus.

<a id="m6"></a>**M6. The AAA "no timing" claim is not met.** (2.2.3) Confirming must happen within 5 minutes unless held, and sessions last 12 hours.
**Fix:** either remove 2.2.3 from the claims, or (a) treat a readback as held by default and rely on the cart-hash binding plus a fresh snapshot check at confirmation, and (b) make sessions slide (refreshed on each request) with a lifetime over 20 hours. (b) also fixes [L15](#l15).
**Fixed:** Not met as AAA; moved to Partial. A late confirmation now hears the order again with a fresh price check, sessions slide to 24 hours, and the "no time limits" claim was removed from the submission text.

### Low

<a id="l1"></a>**L1. AAA contrast miss.** `.muted` (#4a4a4e) on the Checked folder tint (#e9e3cf) is 6.87:1. **Fix:** set `--muted: #3f3f43` in the light theme (`app/globals.css:11`). That gives 8.16:1 on #e9e3cf and 10.1:1 on paper.
**Fixed:** `--muted: #3f3f43`.

<a id="l2"></a>**L2. Standalone text links are 26 px tall** (AAA 2.5.5). **Fix:** add a `.link-target { display: inline-flex; align-items: center; min-height: 44px; }` class. Apply it to the back links on the order and evidence pages, the evidence-pack link, the item links in the orders table and the footer links. **Fixed:** `.link-target` is in `globals.css` and is applied to "All orders and money", "See the signed payment receipt" and "Read the signed evidence pack" on the order page, "Read the evidence pack" in MoneyBack, "Back to your order" on the evidence page, the item links in the orders table, and the three footer links (44 px tall at 320 and 1280 px).

<a id="l3"></a>**L3. The hero animation lasts 5.26 s** (2.2.2). **Fix:** bring `.rbh-say` forward from 4400 ms to 4000 ms and `.rbh-stub` from 4700 ms to 4200 ms in `globals.css`, so the sequence ends by 4.8 s.
**Fixed:** `.rbh-say` at 4000 ms, `.rbh-stub` at 4200 ms; the sequence ends by 4.76 s.

<a id="l4"></a>**L4. Focus drops when a focused control is disabled or removed** (2.4.3). In Chromium 158, `disabled` on the focused button moves `activeElement` to `<body>`. Affected: `components/orders/money-back.tsx:86/100`, `components/orders/ask-helper.tsx:32`, `app/helper/[token]/helper-answer.tsx:55–61`, `app/judge/lifecycle-run.tsx:76`, `app/judge/judge-start.tsx:27`, and `components/check/camera-check.tsx:255`. **Fix:** use `aria-disabled` and return early in the handler, as `conversation.tsx` already does. When a control is replaced, focus its replacement: MoneyBack's result `<p tabIndex={-1}>`, and AskHelper's `#helper-link`. **Fixed:** all six controls use `aria-disabled` and return early while busy, so they keep focus. MoneyBack focuses "Before I send it" when the preview appears, "Get my money back" after "Not now", and its result paragraph after sending (announced with `live: false`; the result's `role="status"` is gone). AskHelper focuses `#helper-link` when the link is made and the Ask button when the link is cancelled. HelperAnswer focuses the thank-you line (announced with `live: false`). These components, LifecycleRun and JudgeStart now announce errors through the announcer instead of `role="alert"`, so errors are not spoken twice. Focus moves run in effects after render, not in `requestAnimationFrame`. Covered by `test/audit-focus.test.tsx`.

<a id="l5"></a>**L5. Network errors are not handled** (3.3.1) in `ask-helper.tsx` (ask and cancel) and `helper-answer.tsx`. **Fix:** wrap each `fetch` in `try/catch`. On failure, call `setError('Could not reach the server. Nothing changed. Try again.')` and `setBusy(false)`. **Fixed:** as proposed, and the message is also announced (assertive). A refused cancel says the link still works. MoneyBack now says "Could not reach the server. Nothing was sent. Try again." instead of the browser's own "Failed to fetch".

<a id="l6"></a>**L6. The verdict heading takes focus on page load in dev builds** (2.4.3). The `first` ref in `components/check/verdict-view.tsx:28–38` survives Strict Mode's second effect run. **Fix:** make the check idempotent with `const initial = useRef(focusOnMount ? null : verdict); useEffect(() => { if (verdict !== initial.current) headingRef.current?.focus(); }, [verdict]);`. **Fixed:** as proposed. A component test under `<StrictMode>` confirms that focus stays put on load and moves to a new verdict.

<a id="l7"></a>**L7. Page titles and the 404 page** (2.4.2, 2.4.1). **Fix:** add `generateMetadata` in `app/app/orders/[id]/page.tsx` returning `${snapshot.title}, order`; set the title "Link expired" when the helper token is invalid; set `metadata = { title: 'Orders · Demo Store' }` in `app/merchant/page.tsx`; and add `app/not-found.tsx` with `<main id="main" tabIndex={-1}>`, `<h1>Page not found</h1>`, a home link and `metadata.title = 'Page not found'`. **Fixed:** order pages are "<item title>, order · Sightline" (`generateMetadata` shares one cached read with the page; an unknown order calls `notFound()` so it gets the 404 title). An invalid helper link is "Link expired · Sightline", and `/merchant` is "Orders · Demo Store · Sightline". `app/not-found.tsx` has the public header and footer, one `<main id="main" tabIndex={-1}>`, the h1, one sentence and a home link, and is titled "Page not found · Sightline". The root layout has no `<main>`, and a `notFound()` inside the buyer area renders this page instead of the buyer layout, so there is always exactly one `main` (checked in the browser).

<a id="l8"></a>**L8. Dashboard charts have no text alternative** (1.1.1). AG Studio names each chart only "interactive chart". **Fix:** under each dashboard, render a server-side `<details><summary>Data for <chart title></summary><table>…</table></details>` for every chart, using the same rows the chart uses. **Fixed:** `components/studio/chart-tables.tsx` renders "The charts as tables" under each dashboard on the server. Each chart gets one disclosure ("Data for Failures by platform", "Data for Where the money is", and so on) with a table whose caption names the chart and its subtitle, plus `th scope="col"` and `scope="row"`. The rows come from `barrierChartTables` and `verifiedDeliveryChartTables`, which sit next to the chart definitions, share their titles, and group, sort and format the data the way each chart does (`test/chart-tables.test.ts`). With every disclosure open: 0 axe violations (AA and AAA contrast) and no overflow at 320, 375 and 1280 px in all three themes.

<a id="l9"></a>**L9. Grid columns can be resized only by dragging** (2.5.7, 2.1.1). **Fix:** set `resizable: false` in `defaultColDef` (`components/merchant/grid.tsx:127`). Text already wraps. **Fixed:** as proposed.

<a id="l10"></a>**L10. The receipt command scrolls but cannot be focused** (2.1.1). **Fix:** at `app/receipts/[id]/page.tsx:140`, either add `tabIndex={0} role="region" aria-label="Command to verify this receipt"`, or set `white-space: pre-wrap; overflow-wrap: anywhere` on `.code` so it never scrolls. **Fixed:** `.code` wraps. The receipt and evidence commands no longer scroll at 320 or 1280 px.

<a id="l11"></a>**L11. "Thinking…" is not announced** (4.1.3). **Fix:** in `send()`, start a 1500 ms timer that calls `announce('Working on it.', { source: 'assistant', speak: false })`, and clear the timer when the reply arrives.
**Fixed:** After 1.5 s without a reply, "Working on it." is announced once (not spoken by the app's own voice); the timer is cleared when the reply or an error arrives.

<a id="l12"></a>**L12. The composer's visible label is only a placeholder** (3.3.2). **Fix:** make the "Or type what you need" label visible (drop `sr-only` at `conversation.tsx:297`) and keep the example in the placeholder.
**Fixed:** The label is visible above the field; the placeholder now starts "For example:".

<a id="l13"></a>**L13. The Talk button's label does not match its behaviour** (3.3.2, 2.4.6). **Fix:** change the visible label to "Talk" and add `aria-describedby` pointing to a hint: "Hold, or press once to start and again to send." The greeting ("Press Talk") then matches.
**Fixed:** Visible label "Talk"; `aria-describedby` points to "Hold to talk, or press once to start and again to send." The hint is visible but hidden from screen readers, so browse mode does not read it twice. While listening the label says "press again to send" or "let go to send".

<a id="l14"></a>**L14. Colour-only reference** (1.3.3). **Fix:** at `app/judge/page.tsx:53`, change "The black panel shows" to "The Speech Viewer panel shows". **Fixed:** as proposed.

<a id="l15"></a>**L15. Sessions end after 12 hours with no warning** (2.2.1). **Fix:** use a sliding session of at least 24 hours in `server/session.ts` (see [M6](#m6)).
**Fixed:** Sessions end 24 hours after the last visit; the row is refreshed at most once an hour. The cookie lasts 30 days; the database decides.

Advisories (not failures): the three "Technical details" disclosures on the order page could carry the step name, for example "Technical details: Paid". The glyphs in the helper buttons ("✓ It matches") will be read aloud by most screen readers; wrap them in `aria-hidden` spans. (**Fixed:** both. The disclosures read "Technical details: Asked", "Technical details: Paid" and "Technical details: Arrived", and the helper buttons are named "It matches", "It’s different" and "I can’t tell".) The theme select's value change and its "Theme: Dark." announcement overlap. "Wait, hold on" moves focus to the card heading even though the button is still there.
