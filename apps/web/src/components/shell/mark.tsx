import { PRODUCT_NAME } from '@sightline/core';

/** Braille dot numbers (1-6) for a-z. Cell layout: 1 4 / 2 5 / 3 6. */
const BRAILLE: Record<string, number[]> = {
  a: [1], b: [1, 2], c: [1, 4], d: [1, 4, 5], e: [1, 5], f: [1, 2, 4], g: [1, 2, 4, 5], h: [1, 2, 5], i: [2, 4], j: [2, 4, 5],
  k: [1, 3], l: [1, 2, 3], m: [1, 3, 4], n: [1, 3, 4, 5], o: [1, 3, 5], p: [1, 2, 3, 4], q: [1, 2, 3, 4, 5], r: [1, 2, 3, 5],
  s: [2, 3, 4], t: [2, 3, 4, 5], u: [1, 3, 6], v: [1, 2, 3, 6], w: [2, 4, 5, 6], x: [1, 3, 4, 6], y: [1, 3, 4, 5, 6], z: [1, 3, 5, 6],
};

export function brailleDots(letter: string): number[] {
  return BRAILLE[letter.toLowerCase()] ?? [];
}

/** The mark: the product's first letter as a braille cell. Decorative; the wordmark carries the name. */
export function BrailleCell({ letter = PRODUCT_NAME[0] ?? 's', size = 28 }: { letter?: string; size?: number }) {
  const on = new Set(brailleDots(letter));
  const order = [1, 4, 2, 5, 3, 6];
  return (
    <span className="braille-cell" style={{ ['--cell' as string]: `${size}px` }} aria-hidden="true">
      {order.map((n) => (
        <span key={n} className="braille-dot" data-on={on.has(n) ? '' : undefined} />
      ))}
    </span>
  );
}

export function Wordmark({ size = 28 }: { size?: number }) {
  return (
    <span className="wordmark">
      <BrailleCell size={size} />
      <span className="wordmark-text">{PRODUCT_NAME}</span>
    </span>
  );
}
