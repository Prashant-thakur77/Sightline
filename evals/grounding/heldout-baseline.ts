/**
 * Scores the grounding guard as it stood before the date, negation and citation checks on the
 * held-out split, and writes the totals to heldout-baseline.json. Run once, on that commit; the
 * grounding suite reads the file and shows the totals as the "before" column. Totals only: the
 * per-case outcome is not printed, so it cannot steer later work.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkGrounding } from '@sightline/agent';
import { demoItem, demoProduct, freezeSnapshot } from '../lib/commerce';
import { execFileSync } from 'node:child_process';
import { REPO_ROOT } from '../lib/results';
import { sizeOf } from './answers';
import { HELDOUT_ESTIMATE, HELDOUT_NOW, heldoutCases } from './heldout';

const SOURCE = 'listing-reviews';
const totals: Record<string, { unsupported: number; caught: number; supported: number; blocked: number }> =
  {};
for (const c of heldoutCases(SOURCE)) {
  const item = demoItem(c.slug);
  const sel: Record<string, string> = { Colour: c.colour };
  const size = sizeOf(item);
  if (size) sel.Size = size;
  const snap = freezeSnapshot(
    demoProduct(c.slug, sel),
    new Date(HELDOUT_NOW.getTime() - 60_000),
    `snap_${c.id}`,
  );
  const r = checkGrounding({
    segments: [c.segment],
    snapshots: [snap],
    archives: { [SOURCE]: (item.reviews ?? []).map((x) => x.quote).join('\n') },
    facts: { 'delivery.estimate': HELDOUT_ESTIMATE },
  });
  const t = (totals[c.group] ??= { unsupported: 0, caught: 0, supported: 0, blocked: 0 });
  if (c.hasUnsupported) {
    t.unsupported++;
    if (!r.supported) t.caught++;
  } else {
    t.supported++;
    if (!r.supported) t.blocked++;
  }
}
const guardCommit = execFileSync(
  'git',
  ['log', '-1', '--format=%h', '--', 'packages/agent/src/grounding.ts'],
  { encoding: 'utf8', cwd: REPO_ROOT },
).trim();
const out = {
  guard: `packages/agent/src/grounding.ts at ${guardCommit}`,
  now: HELDOUT_NOW.toISOString(),
  totals,
};
writeFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'heldout-baseline.json'),
  `${JSON.stringify(out, null, 2)}\n`,
);
console.log(JSON.stringify(out));
