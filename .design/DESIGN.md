# Design system (v2: Offset Print)

## Taste
- **IS:** gentle (sweet, never childish: soft shapes, a kind first-person voice, small human details), lucid (minimal and clear: one idea per screen, 7:1 text), assured (cool confidence about money: precise alignment, one cobalt for the one action that matters).
- **NEVER:** pitiful or charity-toned; clinical or corporate; noisy (no autoplay sound, no scroll-jacking, no looping attention-seekers, no hover-only meaning).
- **Feel in motion:** soft and precise, like a calm voice and a careful hand. Lines draw and settle; nothing bounces or spins; reveals happen once.
- **Materials:** ice paper (cool white surfaces, very soft long shadows, large radii), ink drawing (one line weight, flat fills set a few pixels off the line), the receipt (monospaced, perforated, white on ice), braille dots (the mark, dividers, the journey's progress).
- **Lines not to cross:** no custom cursor; no smooth-scroll library; no text in images; nothing revealed only on hover or hidden until an animation ends; no colour-only status (every verdict has a word and a shape: ✓ ✕ ?); body text 400+ and 7:1+; the serif only at 28 px and up; the high-contrast theme stays yellow on black with hard edges.

## Direction: Offset Print
Ice and cobalt with hand-made line illustrations whose flat fills sit a few pixels off the line, like soft print. Fraunces (soft, heavy) speaks for page and section titles; Atkinson Hyperlegible Next carries everything people read and press; Atkinson Hyperlegible Mono sets receipts, numbers and spoken examples. White cards with large radii float on icy white; cobalt marks only the one action that matters.

## Tokens (`apps/web/src/app/globals.css`)
- **Colour, light:** ice `--paper #f3f6fb`, `--paper-2 #e8eef9`, `--surface #ffffff`, night `--ink #0d1530` (16.6:1 on ice), `--muted #3b4565` (8.7:1), control edges `--line #5c6688` (5:1+), decoration `--hairline #d3daea`, cobalt `--accent #1a33d6` (7.8:1 on ice; white on it 8.4:1), `--accent-bright #2442ff` (illustration and large display only), sky `--accent-soft #dce6ff` (the current step; ink on it 14:1, never accent or status text on it), peach `--warm #ffe3d6`, status `--match #08572f`, `--mismatch #a01b12`, `--unsure #6b4300` (all 7:1+ on ice and white).
- **Dark:** `--paper #0a0f1f`, `--surface #121a30`, `--ink #eef2fb`, `--muted #b4beda`, `--accent #8ea2ff` with dark text on it (8:1), `--accent-soft #1c2a55`.
- **Contrast (low vision):** black with yellow `#ffd60a` text, white focus ring, 2–6 px edges, no shadows; every status keeps its glyph.
- **Type:** `--font-display` Fraunces 600, `font-variation-settings: 'SOFT' 100`, for h1/h2, landing titles, card titles in the store and the Talk label; `--font-sans` Atkinson Hyperlegible Next 400/500/700/800; `--font-mono` Atkinson Hyperlegible Mono. Fluid scale `--step--1` to `--step-5` in rem so zoom and text size scale it.
- **Space:** `--space-1` 4 px to `--space-9` 112 px (larger steps capped on narrow screens so large text keeps the width).
- **Radius by hierarchy:** 8 px keys and tags, 14 px inputs, 24 px cards and photos, 32 px large panels, pill for buttons, chips and Talk.
- **Depth:** `--shadow-1` (resting card), `--shadow-2` (raised card), `--shadow-3` (stage, current step); none in high contrast.
- **Targets:** 48 px minimum, 60–68 px for main actions, 96 px for Talk.
- **Focus:** one ring everywhere: 3 px night outline + 7 px cobalt halo (white in high contrast).

## Motion
- Durations: fast 160 ms (state), base 240 ms (UI), slow 640 ms (reveals), draw 900 ms (illustration lines), print 90 ms per receipt line.
- Easings: `--ease-out` cubic-bezier(.22,1,.36,1) for everything that arrives; `--ease-in-out` for the listening rings.
- Illustrations (`components/art`): every line has `pathLength=1`; it draws once when 25% visible, staggered 70 ms by `--i`; fills slide 5 px into their offset; small details pop. Sound waves breathe twice (under 5 s) and stop.
- Talk while listening: two soft rings breathe out from the button; stops as soon as listening stops.
- Journey: plain scrolling; the sticky stage cross-fades between drawings (640 ms) as each step crosses the middle of the screen.
- Reduced motion: final frame immediately; nothing moves on its own; state changes stay.

## Signature moment
**The journey** (landing, `#how`): five moments (Ask, Hear it back, PayPal holds it, Check it, Money back). On wide screens the drawing stays beside the words and changes as you read; progress shows as braille-like dots. On a phone each step carries its own drawing. For a screen reader it is an ordered list; drawings are decorative.

## Components
Site header (translucent, sticky only when it fits one row) · app header with pill navigation (`aria-current` filled in night) · buttons (pill; primary cobalt, secondary white with a control edge, danger in red words) · Talk (96 px cobalt pill, serif label) · composer dock (white card with a sky glow) · option cards (white, 32 px radius, cobalt number disc) · receipt (white on ice, perforated, sky KEEP stub) · verdict (glyph and word, photos side by side, table that stacks by its own width in em) · order journey (five step cards on a rail; the current one on sky with "Now"; marks on the rail) · store case desk (case pill above a white card; open cases glow sky at the top) · AG Studio (white widgets on ice, serif titles, cobalt and night series) · Speech Viewer (night panel, cobalt and peach line markers) · illustrations (`HeroArt`, `AskArt`, `ReadbackArt`, `HoldArt`, `CheckArt`, `RefundArt`, `AgentArt`, `StoreArt`, `HelperArt`, `EmptyArt`).
