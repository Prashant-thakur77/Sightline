# Design system

## Taste
- **IS:** clear (poster-scale type, 7:1+ contrast, one idea per screen), warm (a calm first-person voice, paper and fabric next to hard type), fearless (high contrast as a statement, not a compliance afterthought).
- **NEVER:** pitiful or charity-toned; clinical or checklist-looking; noisy (nothing a screen reader would hear as clutter, no autoplay sound, no scroll-jacking, no hover-only meaning).
- **Feel in motion:** precise and calm, like a voice reading a receipt. Mechanical steps, no bounce, no float.
- **Materials:** thermal receipt paper (the readback), woven clothing labels (the check), braille cells (the grid, the mark, the print head), tactile-paving yellow (fields), manila case folders (an order's life).
- **Lines not to cross:** no custom cursor; no smooth-scroll library; no text in images; nothing revealed only on hover; no colour-only status (every verdict has a word and a shape: ✓ ✕ ?); no body weight under 400; no grey under 7:1; no disability tropes.

## Direction: The Case File
Every order is a folder with five tabs, one per moment: **Asked, Paid, Arrived, Checked, Money back**. The readback is a ticket with a perforated edge and a KEEP stub, because it becomes evidence. The signature moment is speech turning into that ticket: the words Sightline acts on get a thick underline and a tag, then the ticket prints line by line while a row of braille dots steps across like a print head.

## Tokens
Defined in `apps/web/src/app/globals.css` as CSS custom properties.
- **Colour (light):** paper `#fbfbf8`, ink `#0b0b0c` (19:1), muted `#4a4a4e` (8.5:1), yellow `#ffd60a` (ink on yellow 13.9:1), signal `#0b3fd9` (7.4:1), match `#075e31` (7.6:1), mismatch `#a4161a` (7.5:1), unsure `#6b4500`.
- **Dark:** paper `#0e1013`, ink `#fbfbf8`, muted `#b9bcc4` (10:1), signal `#8db4ff`, match `#5fd394`, mismatch `#ff8a80`.
- **Contrast (low-vision):** black with yellow text, white focus ring; every status keeps its glyph.
- **Type:** Atkinson Hyperlegible Next (400/500/700/800) for everything; Atkinson Hyperlegible Mono for tickets, hashes and spoken words. Fluid scale `--step--1` to `--step-5` in rem, so browser zoom and text-size settings scale it. Headings 800, tracking -0.02em, `text-wrap: balance`.
- **Space:** `--space-1` (4px) to `--space-9` (112px).
- **Radius by hierarchy:** 6px (keys, focus), 12px (buttons, inputs), 22px (cards, folders, viewfinder), 999px (talk button, chips).
- **Targets:** 48px minimum, 72px for primary actions, 96px for Talk.
- **Focus:** one double ring everywhere: 3px ink outline + 7px yellow halo (white in contrast mode).

## Motion
- Durations: fast 140ms (state), base 240ms (UI), slow 560ms (reveals), print 90ms per ticket line or braille cell.
- Easings: `--ease-out` cubic-bezier(.2,0,0,1) for everything that arrives; `--ease-in-out` cubic-bezier(.6,0,.2,1) for the talk pulse; `steps(n)` for printing.
- Buttons: a hard ink shelf (`0 4px 0 ink`); pressing drops 3px in 140ms, no scaling.
- Reveals happen once; content is in the DOM and readable before motion starts.
- Reduced motion: every animation and transition is effectively instant; the final frame shows.

## Signature moment spec
- Trigger: landing hero on load, and every readback in the app.
- Timeline: spoken sentence appears (mono on a yellow band) → the acted-on words get underline + tag ([navy] [crew neck] [M] [under $40]) at 140ms intervals → the braille print head steps across (90ms per cell) → ticket lines print (clip-path reveal, 90ms each) → KEEP stub settles.
- Screen readers get the same sentence and ticket as plain text; the animated layer is `aria-hidden`.
- Mobile: same sequence, ticket full width. Reduced motion: final frame only.

## Components
Header with braille-cell wordmark · nav with `aria-current` filled in ink · Talk button (96px pill, yellow, ink shelf) · option rows (numbered yellow discs; sequence numbers are real) · readback ticket · verdict (two figures + table of checks with glyph + word + confidence word) · case folder with tabs · Speech Viewer (black panel, yellow edge, mono lines) · receipts check list.
