import type { ProductSnapshot } from '@sightline/core';
import { COLOURS, colourSupport, supportSet } from './lexicon';

/**
 * Contradictions inside a listing that the buyer should hear before paying, e.g. the colour
 * field says navy while the description says black. Deterministic: lexicon matches only.
 */
export function listingWarnings(s: ProductSnapshot): string[] {
  const out: string[] = [];
  const stated = s.attributes.colour;
  if (stated) {
    const statedSet = colourSupport(stated);
    const mentioned = new Set([...supportSet(s.description ?? '', COLOURS), ...supportSet(s.title, COLOURS)]);
    const others = [...mentioned].filter((c) => !statedSet.has(c));
    if (others.length > 0)
      out.push(
        `Note: the colour is listed as ${stated.toLowerCase()}, but the description also mentions ${others.join(' and ')}. I'll check the colour when it arrives.`,
      );
  }
  return out;
}
