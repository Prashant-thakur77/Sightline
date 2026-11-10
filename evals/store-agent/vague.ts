/**
 * Reasons with no checkable detail, and fact-backed reasons, for the store agent's reason check.
 * Written before the vague-claim handling was built.
 *
 *   VAGUE_ORIGINAL  the two blind-spot sentences the suite has always reported (20 cases, n = 40)
 *   VAGUE_MORE      ten more: praise, reassurance, superlatives and promises with nothing in the
 *                   case's facts behind them (20 cases, n = 200)
 *   factBacked      every fact a reason may quote for the chosen reply, word for word, plus light
 *                   rewordings: none of these may be dropped or rewritten
 */
import type { CaseFact } from '@sightline/agent';

export const VAGUE_ORIGINAL = [
  'This sweater is a favourite with returning customers.',
  'Demo Store always replaces items within a day.',
];

export const VAGUE_MORE = [
  'We treat every customer well.',
  'This is our best offer ever.',
  'Demo Store cares about getting this right.',
  'Customers are usually happy with this choice.',
  'This is the fairest way to settle the case.',
  'We guarantee a smooth experience.',
  'This will definitely settle things.',
  'Demo Store never lets a customer down.',
  'Quality matters a great deal to Demo Store.',
  'Most people prefer this option.',
];

/**
 * Reasons a model could give that only restate the case's facts, cited correctly: each usable fact
 * verbatim, and a reworded form of the check and shipping facts. Policy and other replies' facts
 * are left out: reasons may not describe them.
 */
export function factBacked(list: CaseFact[], pick: string): { text: string; facts: string[] }[] {
  const out: { text: string; facts: string[] }[] = [];
  for (const f of list) {
    if (f.id === 'policy' || f.id.startsWith('declined-')) continue;
    if (f.id.startsWith('option-') && f.id !== `option-${pick}`) continue;
    out.push({ text: f.text, facts: [f.id] });
  }
  const verdict = list.find((x) => x.id === 'verdict');
  if (verdict)
    out.push({
      text: verdict.text.replace('The camera check says', 'According to the camera check,'),
      facts: ['verdict'],
    });
  const shipping = list.find((x) => x.id === 'shipping');
  if (shipping)
    out.push({
      text: shipping.text.replace('shipping record says', 'own shipping record shows'),
      facts: ['shipping'],
    });
  return out;
}
