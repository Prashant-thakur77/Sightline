/**
 * Grounding suite: the grounding guard (checkGrounding) over 150 scripted spoken answers about
 * the Demo Store products, half fully supported by the listing and half carrying one invented
 * claim. Baseline: no guard, which speaks every answer and so catches nothing.
 *
 *   catch rate  = answers with an invented claim that the guard flags
 *   false block = fully supported answers that the guard flags
 *
 * Scripted answers; the model-in-the-loop run needs ANTHROPIC_API_KEY.
 *
 * Two splits: the development split (answers.ts and the negation probe) that the checks were
 * built against, and the held-out split (heldout.ts), committed before the date, negation and
 * citation checks and scored by a full run only. `--dev` scores the development split and writes
 * nothing.
 */
import { readFileSync } from 'node:fs';
import { checkGrounding, type GroundingReport, type Segment } from '@sightline/agent';
import type { ProductSnapshot } from '@sightline/core';
import { demoItem, demoProduct, freezeSnapshot } from '../lib/commerce';
import { ofN, scriptPath, writeResult, type Headline } from '../lib/results';
import { bootstrapCI, f1, pct, wilsonText } from '../lib/stats';
import { ESTIMATE, NOW, REVIEWS_SOURCE, buildAnswers, negationProbe, sizeOf, type Category } from './answers';
import { HELDOUT_ESTIMATE, HELDOUT_NOW, heldoutCases, type HeldoutGroup } from './heldout';

const SCRIPT = scriptPath(import.meta.url);
const LABEL = 'scripted answers; the model-in-the-loop run needs ANTHROPIC_API_KEY';
/** `--dev` scores the development split only and writes nothing. The held-out split is scored by a full run. */
const DEV_ONLY = process.argv.includes('--dev');

function snapshotFor(slug: string, colour: string, id: string, now: Date): ProductSnapshot {
  const item = demoItem(slug);
  const sel: Record<string, string> = { Colour: colour };
  const size = sizeOf(item);
  if (size) sel.Size = size;
  return freezeSnapshot(demoProduct(slug, sel), new Date(now.getTime() - 60_000), id);
}

function check(slug: string, colour: string, id: string, segments: Segment[], now = NOW, estimate = ESTIMATE): GroundingReport {
  const item = demoItem(slug);
  return checkGrounding({
    segments,
    snapshots: [snapshotFor(slug, colour, id, now)],
    archives: { [REVIEWS_SOURCE]: (item.reviews ?? []).map((r) => r.quote).join('\n') },
    facts: { 'delivery.estimate': estimate },
    now,
  });
}

interface Totals {
  unsupported: number;
  caught: number;
  supported: number;
  blocked: number;
}
const readJson = <T>(name: string): T => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8')) as T;
/** The previous run's numbers on the development split, kept as the "before" column. */
const DEV_BEFORE = readJson<{ from: string; headlines: Record<string, string>; byCategory: Record<string, { n: number; caught: number }> }>('./dev-baseline.json');
/** The guard before the date, negation and citation checks, on the held-out split (heldout-baseline.ts). */
const HELDOUT_BEFORE = readJson<{ guard: string; totals: Record<HeldoutGroup, Totals> }>('./heldout-baseline.json');
const HELDOUT_GROUPS: HeldoutGroup[] = ['delivery_date', 'negation', 'citation'];
const sumTotals = (t: Record<HeldoutGroup, Totals>): Totals =>
  HELDOUT_GROUPS.reduce((a, g) => ({ unsupported: a.unsupported + t[g].unsupported, caught: a.caught + t[g].caught, supported: a.supported + t[g].supported, blocked: a.blocked + t[g].blocked }), {
    unsupported: 0,
    caught: 0,
    supported: 0,
    blocked: 0,
  });

function heldout() {
  const rows = heldoutCases(REVIEWS_SOURCE).map((c) => {
    const r = check(c.slug, c.colour, `snap_${c.id}`, [c.segment], HELDOUT_NOW, HELDOUT_ESTIMATE);
    return { id: c.id, group: c.group, product: c.slug, text: c.segment.text, hasUnsupported: c.hasUnsupported, flagged: !r.supported, reasons: r.unsupported.flatMap((u) => u.reasons) };
  });
  const totals = Object.fromEntries(
    HELDOUT_GROUPS.map((g) => {
      const inG = rows.filter((r) => r.group === g);
      const bad = inG.filter((r) => r.hasUnsupported);
      const good = inG.filter((r) => !r.hasUnsupported);
      return [g, { unsupported: bad.length, caught: bad.filter((r) => r.flagged).length, supported: good.length, blocked: good.filter((r) => r.flagged).length }];
    }),
  ) as Record<HeldoutGroup, Totals>;
  return { rows, totals, all: sumTotals(totals), before: sumTotals(HELDOUT_BEFORE.totals) };
}

async function main() {
  const answers = buildAnswers();
  const rows = answers.map((a) => {
    const report = check(a.slug, a.colour, `snap_${a.id}`, a.segments);
    const flaggedIdx = report.unsupported.map((u) => u.index);
    const flagged = !report.supported;
    return {
      id: a.id,
      category: a.category,
      product: a.slug,
      colour: a.colour,
      hasUnsupported: a.hasUnsupported,
      flagged,
      rightSegment: a.hasUnsupported ? flaggedIdx.includes(a.unsupportedIndex!) && flaggedIdx.length === 1 : flaggedIdx.length === 0,
      text: a.segments.map((s) => s.text).join(' '),
      invented: a.unsupportedIndex !== undefined ? a.segments[a.unsupportedIndex]!.text : null,
      spoken: report.text,
      reasons: report.unsupported.flatMap((u) => u.reasons),
    };
  });

  const bad = rows.filter((r) => r.hasUnsupported);
  const good = rows.filter((r) => !r.hasUnsupported);
  const caught = bad.filter((r) => r.flagged);
  const caughtRight = bad.filter((r) => r.rightSegment);
  const blocked = good.filter((r) => r.flagged);
  const misses = bad.filter((r) => !r.flagged);

  const categories: Exclude<Category, 'supported'>[] = ['size', 'material', 'price', 'return_window', 'delivery_date', 'fake_quote'];
  const byCategory = categories.map((c) => {
    const inCat = bad.filter((r) => r.category === c);
    const k = inCat.filter((r) => r.flagged).length;
    return {
      category: c,
      n: inCat.length,
      caught: k,
      interval: wilsonText(k, inCat.length),
      missed: inCat.filter((r) => !r.flagged).map((r) => ({ id: r.id, product: r.product, invented: r.invented })),
    };
  });
  const worst = [...byCategory].sort((a, b) => a.caught / a.n - b.caught / b.n)[0]!;

  const pairs = rows.map((r) => ({ truth: r.hasUnsupported, predicted: r.flagged }));
  const f1Value = f1(pairs);
  const f1Ci = bootstrapCI(pairs, f1, { seed: 20261109, resamples: 5000 });

  // Known weakness: negated false statements.
  const probe = negationProbe().map((p) => {
    const report = check(p.slug, p.colour, `snap_${p.id}`, [p.segment]);
    return { id: p.id, product: p.slug, said: p.segment.text, truth: p.truth, passed: report.supported };
  });
  const probePassed = probe.filter((p) => p.passed);
  const example = probePassed[0];

  if (DEV_ONLY) {
    console.log(`grounding --dev: caught ${ofN(caught.length, bad.length)}, false block ${ofN(blocked.length, good.length)}, negation passed ${ofN(probePassed.length, probe.length)}. Nothing written.`);
    for (const c of byCategory) console.log(`  ${c.category}: ${c.caught}/${c.n} missed ${JSON.stringify(c.missed.map((m) => m.invented))}`);
    for (const b of blocked) console.log(`  FALSE BLOCK ${b.id}: ${b.text} :: ${b.reasons.join('; ')}`);
    for (const p of probePassed) console.log(`  NEGATION PASSED ${p.id}: ${p.said}`);
    return;
  }

  const category = (c: string) => c.replace('_', ' ');
  const devBefore = (id: string) => DEV_BEFORE.headlines[id]?.replace(/ \(.*\)$/, '').replace(/ caught$/, '');
  const delivery = byCategory.find((c) => c.category === 'delivery_date')!;
  const deliveryBefore = DEV_BEFORE.byCategory.delivery_date!;
  const held = heldout();
  const hd = held.totals.delivery_date;
  const hn = held.totals.negation;
  const hc = held.totals.citation;
  const bd = HELDOUT_BEFORE.totals.delivery_date;
  const bn = HELDOUT_BEFORE.totals.negation;
  const heldMissed = held.rows.filter((r) => r.hasUnsupported && !r.flagged);
  const heldBlocked = held.rows.filter((r) => !r.hasUnsupported && r.flagged);
  const headlines: Headline[] = [
    {
      id: 'catch-rate',
      label: 'Answers with one invented claim that the grounding guard catches',
      value: `${ofN(caught.length, bad.length)} (${pct(caught.length / bad.length)})`,
      baseline: `before: ${devBefore('catch-rate')}; no guard: ${ofN(0, bad.length)}`,
      interval: wilsonText(caught.length, bad.length),
      n: bad.length,
      script: SCRIPT,
      note: `Simulated: ${LABEL}. Development split. Invented size, material, price, return window, delivery date or quote.`,
    },
    {
      id: 'false-block',
      label: 'Fully supported answers the guard wrongly blocks',
      value: ofN(blocked.length, good.length),
      baseline: `before: ${devBefore('false-block')}; no guard: ${ofN(0, good.length)}`,
      interval: wilsonText(blocked.length, good.length),
      n: good.length,
      script: SCRIPT,
      note: `Simulated: ${LABEL}. Development split.`,
    },
    {
      id: 'f1',
      label: 'F1 of the guard as a detector of unsupported answers',
      value: f1Value.toFixed(2),
      baseline: `before: ${devBefore('f1')}; no guard: 0.00`,
      interval: `95% bootstrap ${f1Ci[0].toFixed(2)}–${f1Ci[1].toFixed(2)}`,
      n: rows.length,
      script: SCRIPT,
    },
    {
      id: 'delivery-date',
      label: 'Invented delivery dates caught',
      value: ofN(delivery.caught, delivery.n),
      baseline: `before: ${ofN(deliveryBefore.caught, deliveryBefore.n)}; no guard: ${ofN(0, delivery.n)}`,
      interval: wilsonText(delivery.caught, delivery.n),
      n: delivery.n,
      script: SCRIPT,
      negative: delivery.caught < delivery.n || undefined,
      note: `Development split. Dates are read in any common form ("Friday", "next week", "in two days", "Nov 20") against a clock passed in, and compared with the store's estimate.${delivery.missed.length ? ` Missed, e.g. "${delivery.missed[0]!.invented}"` : ''}`,
    },
    {
      id: 'worst-category',
      label: `Weakest category: invented ${category(worst.category)}`,
      value: `${ofN(worst.caught, worst.n)} caught`,
      baseline: `no guard: ${ofN(0, worst.n)}`,
      interval: wilsonText(worst.caught, worst.n),
      n: worst.n,
      script: SCRIPT,
      negative: worst.caught < worst.n,
      note: worst.missed.length > 0 ? `Development split. Missed, e.g. "${worst.missed[0]!.invented}"` : 'Nothing missed in this category.',
    },
    {
      id: 'negation',
      label: 'False statements made by negating a listed fact that pass the guard',
      value: ofN(probePassed.length, probe.length),
      baseline: `before: ${devBefore('negation')}`,
      interval: wilsonText(probePassed.length, probe.length),
      n: probe.length,
      script: SCRIPT,
      negative: probePassed.length > 0 || undefined,
      note: example
        ? `Development split. e.g. "${example.said}" on ${example.product.replace(/-/g, ' ')} (${example.truth.toLowerCase().replace(/\.$/, '')}).`
        : 'Development split. Each token carries the polarity of its clause; denying something the cited source states is caught.',
    },
    {
      id: 'heldout-catch',
      label: 'Held-out split: unsupported answers caught',
      value: ofN(held.all.caught, held.all.unsupported),
      baseline: `before: ${ofN(held.before.caught, held.before.unsupported)}`,
      interval: wilsonText(held.all.caught, held.all.unsupported),
      n: held.all.unsupported,
      script: SCRIPT,
      negative: held.all.caught < held.all.unsupported || undefined,
      note: `Scored once, after the checks were built on the development split. Delivery dates ${ofN(hd.caught, hd.unsupported)} (before ${ofN(bd.caught, bd.unsupported)}), false negations ${ofN(hn.caught, hn.unsupported)} (before ${ofN(bn.caught, bn.unsupported)}), citations ${ofN(hc.caught, hc.unsupported)} (before ${ofN(HELDOUT_BEFORE.totals.citation.caught, hc.unsupported)}).${heldMissed.length ? ` Missed: ${heldMissed.map((r) => `"${r.text}"`).join(', ')}.` : ''}`,
    },
    {
      id: 'heldout-false-block',
      label: 'Held-out split: supported answers wrongly blocked',
      value: ofN(held.all.blocked, held.all.supported),
      baseline: `before: ${ofN(held.before.blocked, held.before.supported)}`,
      interval: wilsonText(held.all.blocked, held.all.supported),
      n: held.all.supported,
      script: SCRIPT,
      negative: held.all.blocked > 0 || undefined,
      note: `Delivery dates ${ofN(hd.blocked, hd.supported)}, true negations ${ofN(hn.blocked, hn.supported)}, citations ${ofN(hc.blocked, hc.supported)}.${heldBlocked.length ? ` Blocked: ${heldBlocked.map((r) => `"${r.text}"`).join(', ')}.` : ''}`,
    },
  ];

  const limitations = [
    `Simulated: ${LABEL}. No model wrote these answers; real model answers will differ in wording and in which fields they cite.`,
    'Answers and phrasings were written by the author of this harness before the guard was run on them; they are not a blind or third-party set. The held-out split (evals/grounding/heldout.ts) was written and committed before the date, negation and citation checks, by the same author, and scored once.',
    `"Before" on the development split is the previous run (${DEV_BEFORE.from}); on the held-out split it is ${HELDOUT_BEFORE.guard}, scored by evals/grounding/heldout-baseline.ts.`,
    'The guard checks tokens with the polarity of their clause. Phrasings without a product token ("half price", "a full year", "extra extra large") still carry nothing for it to check, and a denial of something it has no word for passes.',
    'Delivery dates are read against a fixed clock: 2026-11-09 12:00 UTC on the development split, 2026-11-12 09:00 UTC on the held-out split. "next Tuesday" means the Tuesday of the following week, and a named day must be the estimate\'s day.',
  ];

  writeResult('grounding', {
    title: 'Grounded answers',
    headlines,
    limitations,
    details: {
      label: LABEL,
      guard:
        'checkGrounding in packages/agent/src/grounding.ts; a segment is unsupported when any product token in it is not backed by a valid claim with the same polarity, or it reports what reviewers said without a verbatim quote',
      totals: {
        answers: rows.length,
        unsupported: { n: bad.length, caught: caught.length, caughtOnTheRightSegment: caughtRight.length, interval: wilsonText(caught.length, bad.length) },
        supported: { n: good.length, blocked: blocked.length, interval: wilsonText(blocked.length, good.length) },
        f1: { value: Number(f1Value.toFixed(4)), bootstrap95: [Number(f1Ci[0].toFixed(4)), Number(f1Ci[1].toFixed(4))], seed: 20261109, resamples: 5000 },
      },
      before: DEV_BEFORE,
      byCategory,
      misses: misses.map((r) => ({ id: r.id, category: r.category, product: r.product, invented: r.invented })),
      falseBlocks: blocked.map((r) => ({ id: r.id, product: r.product, text: r.text, reasons: r.reasons })),
      negationProbe: probe,
      heldout: { now: HELDOUT_NOW.toISOString(), estimate: HELDOUT_ESTIMATE.toISOString(), totals: held.totals, before: HELDOUT_BEFORE, cases: held.rows },
      answers: rows,
    },
  });

  console.log(`grounding: caught ${ofN(caught.length, bad.length)}, false block ${ofN(blocked.length, good.length)}, F1 ${f1Value.toFixed(2)} [${f1Ci.map((x) => x.toFixed(2)).join(', ')}], negation passed ${ofN(probePassed.length, probe.length)}`);
  for (const c of byCategory) console.log(`  ${c.category}: ${c.caught}/${c.n} missed ${JSON.stringify(c.missed.map((m) => m.invented))}`);
  for (const b of blocked) console.log(`  FALSE BLOCK ${b.id}: ${b.text} :: ${b.reasons.join('; ')}`);
  console.log(`grounding held-out: caught ${ofN(held.all.caught, held.all.unsupported)}, wrongly blocked ${ofN(held.all.blocked, held.all.supported)}`);
  for (const g of HELDOUT_GROUPS) console.log(`  ${g}: caught ${ofN(held.totals[g].caught, held.totals[g].unsupported)}, blocked ${ofN(held.totals[g].blocked, held.totals[g].supported)}`);
}

await main();
