/**
 * Grounding suite: the grounding guard (checkGrounding) over 150 scripted spoken answers about
 * the Demo Store products, half fully supported by the listing and half carrying one invented
 * claim. Baseline: no guard, which speaks every answer and so catches nothing.
 *
 *   catch rate  = answers with an invented claim that the guard flags
 *   false block = fully supported answers that the guard flags
 *
 * Scripted answers; the model-in-the-loop run needs ANTHROPIC_API_KEY.
 */
import { checkGrounding, type GroundingReport, type Segment } from '@sightline/agent';
import type { ProductSnapshot } from '@sightline/core';
import { demoItem, demoProduct, freezeSnapshot } from '../lib/commerce';
import { ofN, scriptPath, writeResult, type Headline } from '../lib/results';
import { bootstrapCI, f1, pct, wilsonText } from '../lib/stats';
import { ESTIMATE, NOW, REVIEWS_SOURCE, buildAnswers, negationProbe, sizeOf, type Category } from './answers';

const SCRIPT = scriptPath(import.meta.url);
const LABEL = 'scripted answers; the model-in-the-loop run needs ANTHROPIC_API_KEY';

function snapshotFor(slug: string, colour: string, id: string): ProductSnapshot {
  const item = demoItem(slug);
  const sel: Record<string, string> = { Colour: colour };
  const size = sizeOf(item);
  if (size) sel.Size = size;
  return freezeSnapshot(demoProduct(slug, sel), new Date(NOW.getTime() - 60_000), id);
}

function check(slug: string, colour: string, id: string, segments: Segment[]): GroundingReport {
  const item = demoItem(slug);
  return checkGrounding({
    segments,
    snapshots: [snapshotFor(slug, colour, id)],
    archives: { [REVIEWS_SOURCE]: (item.reviews ?? []).map((r) => r.quote).join('\n') },
    facts: { 'delivery.estimate': ESTIMATE },
  });
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

  const category = (c: string) => c.replace('_', ' ');
  const headlines: Headline[] = [
    {
      id: 'catch-rate',
      label: 'Answers with one invented claim that the grounding guard catches',
      value: `${ofN(caught.length, bad.length)} (${pct(caught.length / bad.length)})`,
      baseline: `no guard: ${ofN(0, bad.length)}`,
      interval: wilsonText(caught.length, bad.length),
      n: bad.length,
      script: SCRIPT,
      note: `Simulated: ${LABEL}. Invented size, material, price, return window, delivery date or quote.`,
    },
    {
      id: 'false-block',
      label: 'Fully supported answers the guard wrongly blocks',
      value: ofN(blocked.length, good.length),
      baseline: `no guard: ${ofN(0, good.length)}`,
      interval: wilsonText(blocked.length, good.length),
      n: good.length,
      script: SCRIPT,
      note: `Simulated: ${LABEL}.`,
    },
    {
      id: 'f1',
      label: 'F1 of the guard as a detector of unsupported answers',
      value: f1Value.toFixed(2),
      baseline: 'no guard: 0.00',
      interval: `95% bootstrap ${f1Ci[0].toFixed(2)}–${f1Ci[1].toFixed(2)}`,
      n: rows.length,
      script: SCRIPT,
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
      note: worst.missed.length > 0 ? `Missed, e.g. "${worst.missed[0]!.invented}"` : 'Nothing missed in this category.',
    },
    {
      id: 'negation',
      label: 'False statements made by negating a listed fact that pass the guard',
      value: ofN(probePassed.length, probe.length),
      interval: wilsonText(probePassed.length, probe.length),
      n: probe.length,
      script: SCRIPT,
      negative: true,
      note: example ? `e.g. "${example.said}" on ${example.product.replace(/-/g, ' ')} (${example.truth.toLowerCase().replace(/\.$/, '')}). The guard checks tokens, not polarity.` : 'No negated statement passed.',
    },
  ];

  const limitations = [
    `Simulated: ${LABEL}. No model wrote these answers; real model answers will differ in wording and in which fields they cite.`,
    'Answers and phrasings were written by the author of this harness before the guard was run on them; they are not a blind or third-party set.',
    'The guard is a token-level check. It does not judge polarity (negation), and phrasings without a product token ("half price", "tomorrow", "never pills") carry nothing for it to check.',
    'Delivery dates are checked against the store\'s own estimate with "today" fixed at 2026-11-09.',
  ];

  writeResult('grounding', {
    title: 'Grounded answers',
    headlines,
    limitations,
    details: {
      label: LABEL,
      guard: 'checkGrounding in packages/agent/src/grounding.ts; a segment is unsupported when any product token in it is not backed by a valid claim',
      totals: {
        answers: rows.length,
        unsupported: { n: bad.length, caught: caught.length, caughtOnTheRightSegment: caughtRight.length, interval: wilsonText(caught.length, bad.length) },
        supported: { n: good.length, blocked: blocked.length, interval: wilsonText(blocked.length, good.length) },
        f1: { value: Number(f1Value.toFixed(4)), bootstrap95: [Number(f1Ci[0].toFixed(4)), Number(f1Ci[1].toFixed(4))], seed: 20261109, resamples: 5000 },
      },
      byCategory,
      misses: misses.map((r) => ({ id: r.id, category: r.category, product: r.product, invented: r.invented })),
      falseBlocks: blocked.map((r) => ({ id: r.id, product: r.product, text: r.text, reasons: r.reasons })),
      negationProbe: probe,
      answers: rows,
    },
  });

  console.log(`grounding: caught ${ofN(caught.length, bad.length)}, false block ${ofN(blocked.length, good.length)}, F1 ${f1Value.toFixed(2)} [${f1Ci.map((x) => x.toFixed(2)).join(', ')}], negation passed ${ofN(probePassed.length, probe.length)}`);
  for (const c of byCategory) console.log(`  ${c.category}: ${c.caught}/${c.n} missed ${JSON.stringify(c.missed.map((m) => m.invented))}`);
  for (const b of blocked) console.log(`  FALSE BLOCK ${b.id}: ${b.text} :: ${b.reasons.join('; ')}`);
}

await main();
