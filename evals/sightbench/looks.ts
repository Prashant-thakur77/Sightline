/**
 * SightBench, three changes to the camera check, scored on the frozen test split next to the
 * current numbers (never instead of them):
 *
 *   TWO LOOKS      a "sure" mismatch needs two independent signals that agree (two modules, or one
 *                  module on two photos). Applied to the module outputs saved by the last with-model
 *                  test run: all 420 pairs, no new model call.
 *   QUOTED READS   identity and damage reads must name a visible region and what is there, checked
 *                  in code; a read without one counts as "not sure". New model reads, so only a
 *                  stratified subset of the test split (budget), with two looks.
 *   ONE RETAKE     when the check is "not sure" it asks for ONE extra photo chosen from why (size tag
 *                  close-up, better light, white paper next to the item) and checks again with both.
 *                  SightBench has one photo per item, so the extra photos are SIMULATED renders of the
 *                  same item (py/sightbench/retake.py). Every such number says "simulated retake".
 *
 * Input: the per-pair rows written by `python -m app.looks_bench` (services/vision), see README.
 *
 *   (cd evals && pnpm exec tsx sightbench/looks.ts [--rows <rows-test.json>] [--dev <rows-dev.json>])
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { EVALS_DIR, ofN, scriptPath, writeResult, type Headline } from '../lib/results';
import { pct, wilson, wilsonText, type Interval } from '../lib/stats';

const SCRIPT = scriptPath(import.meta.url);
const HERE = path.join(EVALS_DIR, 'sightbench');
const LOOKS = path.join(EVALS_DIR, 'data', 'raw', 'sightbench', 'looks');
const SYNTH = 'Synthetic renders, not real photos';
const SIM = 'SIMULATED retake: the extra photo is a render of the same item, not a photo a buyer took';

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const ROWS = opt('--rows') ?? path.join(LOOKS, 'rows-test.json');
const DEV = opt('--dev') ?? path.join(LOOKS, 'rows-dev.json');

type Kind = 'match' | 'mismatch' | 'unsure';
interface Sys {
  kind: Kind;
  disagree: string[];
  retake: string | null;
  retakeModule: string | null;
  signals: number | null;
  retakeKind?: string | null;
}
interface Row {
  id: string;
  expected: 'match' | 'mismatch';
  mismatchType: string | null;
  subtype: string | null;
  lighting: string;
  productType: string;
  inSample: boolean;
  current?: Sys;
  replayOld?: Kind;
  twoLooks?: Sys;
  quoted?: Sys;
  quotedRetake?: Sys;
  quotedReads?: { identity: { finding: string; confidence: string; reason: string | null }; damage: { finding: string; confidence: string; uncited: string[] } };
  notRun?: string;
}
interface RowsFile {
  split: string;
  generatedAt: string;
  thresholds: string;
  promptVersion: string;
  model: string;
  effort: string | null;
  sample: string[];
  spend: { thisRunUsd: number; ledgerUsd: number; ledgerCalls: number; capUsd: number; prices: Record<string, [number, number]> };
  stopped: string | null;
  rows: Row[];
}

interface Rate {
  k: number;
  n: number;
  value: number | null;
  wilson: Interval | null;
}
const rate = (k: number, n: number): Rate => ({ k, n, value: n ? k / n : null, wilson: n ? wilson(k, n) : null });
const slash = (r: Rate) => `${r.k}/${r.n}`;

type Pick = (r: Row) => Sys | undefined;

function score(rows: Row[], pick: Pick) {
  const xs = rows.filter((r) => pick(r));
  const mm = xs.filter((r) => r.expected === 'mismatch');
  const ma = xs.filter((r) => r.expected === 'match');
  const k = (r: Row) => pick(r)!.kind;
  const decided = xs.filter((r) => k(r) !== 'unsure');
  const perType = Object.fromEntries(
    ['colour', 'size', 'model', 'damage'].map((t) => {
      const ys = mm.filter((r) => r.mismatchType === t);
      return [t, rate(ys.filter((r) => k(r) === 'mismatch').length, ys.length)];
    }),
  );
  const disagreeOnMatch = ma.filter((r) => pick(r)!.disagree.length > 0);
  const byModule: Record<string, number> = {};
  for (const r of disagreeOnMatch) for (const m of new Set(pick(r)!.disagree)) byModule[m] = (byModule[m] ?? 0) + 1;
  return {
    n: xs.length,
    mismatchRecall: rate(mm.filter((r) => k(r) === 'mismatch').length, mm.length),
    falseAlarm: rate(ma.filter((r) => k(r) === 'mismatch').length, ma.length),
    abstention: rate(xs.filter((r) => k(r) === 'unsure').length, xs.length),
    accuracyWhenDecided: rate(decided.filter((r) => k(r) === r.expected).length, decided.length),
    matchConfirmed: rate(ma.filter((r) => k(r) === 'match').length, ma.length),
    wrongMatch: rate(mm.filter((r) => k(r) === 'match').length, mm.length),
    perType,
    /** Matching pairs given any disagreeing reason (the buyer hears a difference that is not there). */
    falseAlarmTwin: rate(disagreeOnMatch.length, ma.length),
    falseAlarmTwinByModule: byModule,
  };
}

const short = (r: Rate) => `${ofN(r.k, r.n)} (${pct(r.value ?? 0)})`;

function main() {
  if (!existsSync(ROWS)) {
    console.error(`looks: no rows at ${ROWS}. Run python -m app.looks_bench first (see evals/sightbench/README.md).`);
    process.exit(1);
  }
  const t = JSON.parse(readFileSync(ROWS, 'utf8')) as RowsFile;
  if (t.split !== 'test') throw new Error('looks: the headline rows must be from the test split');
  const freeze = JSON.parse(readFileSync(path.join(HERE, 'manifests', 'test.freeze.json'), 'utf8'));
  const testSha = createHash('sha256').update(readFileSync(path.join(HERE, 'manifests', 'test.json'))).digest('hex');
  if (testSha !== freeze.sha256) throw new Error('looks: the test manifest changed since it was frozen');
  const rows = t.rows;
  const replayed = rows.filter((r) => r.current && r.replayOld);
  const replayDiff = replayed.filter((r) => r.replayOld !== r.current!.kind).length;
  if (replayDiff) throw new Error(`looks: re-fusing the saved module outputs with the old rule changed ${replayDiff} verdicts; the re-scoring is not faithful`);

  const full = { current: score(rows, (r) => r.current), twoLooks: score(rows, (r) => r.twoLooks) };
  const sampleRows = rows.filter((r) => r.quoted && r.quotedRetake);
  const notRun = rows.filter((r) => r.notRun).length;
  const sub = {
    current: score(sampleRows, (r) => r.current),
    twoLooks: score(sampleRows, (r) => r.twoLooks),
    quoted: score(sampleRows, (r) => r.quoted),
    quotedRetake: score(sampleRows, (r) => r.quotedRetake),
  };
  const retakesAsked: Record<string, number> = {};
  for (const r of sampleRows) if (r.quoted!.kind === 'unsure') retakesAsked[r.quoted!.retake ?? 'none'] = (retakesAsked[r.quoted!.retake ?? 'none'] ?? 0) + 1;
  const retakeAskedFull: Record<string, number> = {};
  for (const r of rows) if (r.twoLooks?.kind === 'unsure') retakeAskedFull[r.twoLooks.retake ?? 'none'] = (retakeAskedFull[r.twoLooks.retake ?? 'none'] ?? 0) + 1;
  // Where the extra photo changed the answer.
  const moves: Record<string, number> = {};
  for (const r of sampleRows) {
    const key = `${r.expected}: ${r.quoted!.kind} -> ${r.quotedRetake!.kind}`;
    if (r.quoted!.kind !== r.quotedRetake!.kind) moves[key] = (moves[key] ?? 0) + 1;
  }
  const uncited = {
    identity: sampleRows.filter((r) => r.quotedReads?.identity.reason === 'no_citation').length,
    damage: sampleRows.filter((r) => (r.quotedReads?.damage.uncited ?? []).length > 0).length,
    identityOnMatch: sampleRows.filter((r) => r.expected === 'match' && r.quotedReads?.identity.reason === 'no_citation').length,
    damageOnMatch: sampleRows.filter((r) => r.expected === 'match' && (r.quotedReads?.damage.uncited ?? []).length > 0).length,
  };
  const n = sampleRows.length;
  const nMatch = sampleRows.filter((r) => r.expected === 'match').length;
  const cells: Record<string, number> = {};
  for (const r of sampleRows) cells[`${r.expected}${r.mismatchType ? ` ${r.mismatchType}` : ''} / ${r.lighting}`] = (cells[`${r.expected}${r.mismatchType ? ` ${r.mismatchType}` : ''} / ${r.lighting}`] ?? 0) + 1;

  const dev = existsSync(DEV) ? (JSON.parse(readFileSync(DEV, 'utf8')) as RowsFile) : null;
  const devRows = dev?.rows.filter((r) => r.quoted && r.quotedRetake) ?? [];
  const devScores = dev ? { n: devRows.length, quoted: score(devRows, (r) => r.quoted), quotedRetake: score(devRows, (r) => r.quotedRetake) } : null;

  const tl = full.twoLooks;
  const cu = full.current;
  const subNote = `Stratified test subset of ${n} pairs (${nMatch} matching; mismatches spread over type and light), chosen in a fixed hash order before any read was made${notRun ? `; ${notRun} sampled pairs were not run (budget)` : ''}.`;
  const headlines: Headline[] = [
    {
      id: 'two-looks-recall',
      label: 'Two looks before "sure": mismatches flagged on the frozen test split',
      value: short(tl.mismatchRecall),
      baseline: `current rule: ${ofN(cu.mismatchRecall.k, cu.mismatchRecall.n)}`,
      interval: wilsonText(tl.mismatchRecall.k, tl.mismatchRecall.n),
      n: tl.mismatchRecall.n,
      script: SCRIPT,
      negative: tl.mismatchRecall.k < cu.mismatchRecall.k,
      note: `${SYNTH}. The same saved module outputs as the current numbers, fused with the two-looks rule (no new model call). A "sure" disagreement from one module on one photo becomes "not sure" with one extra photo asked for. Per type, current -> two looks: ${['colour', 'size', 'model', 'damage'].map((x) => `${x} ${cu.perType[x]!.k} -> ${tl.perType[x]!.k} of ${tl.perType[x]!.n}`).join(', ')}.`,
    },
    {
      id: 'two-looks-false-alarms',
      label: 'Two looks before "sure": matching items wrongly called a mismatch',
      value: short(tl.falseAlarm),
      baseline: `current rule: ${ofN(cu.falseAlarm.k, cu.falseAlarm.n)}`,
      interval: wilsonText(tl.falseAlarm.k, tl.falseAlarm.n),
      n: tl.falseAlarm.n,
      script: SCRIPT,
      note: `${SYNTH}. Same pairs and module outputs as the current numbers.`,
    },
    {
      id: 'two-looks-abstain-accuracy',
      label: 'Two looks before "sure": "not sure" / accuracy when it answers',
      value: `${slash(tl.abstention)} · ${slash(tl.accuracyWhenDecided)}`,
      baseline: `current: ${slash(cu.abstention)} · ${slash(cu.accuracyWhenDecided)}`,
      n: tl.abstention.n,
      script: SCRIPT,
      note: `${SYNTH}. Accuracy when it answers ${pct(tl.accuracyWhenDecided.value ?? 0)} (${wilsonText(tl.accuracyWhenDecided.k, tl.accuracyWhenDecided.n)}), current ${pct(cu.accuracyWhenDecided.value ?? 0)}. Extra photo asked for on the "not sure" pairs: ${Object.entries(retakeAskedFull).map(([k, v]) => `${k} ${v}`).join(', ')}.`,
    },
    {
      id: 'quoted-false-alarm-twin',
      label: 'Quoted reads (with two looks): matching items given any disagreeing reason',
      value: short(sub.quoted.falseAlarmTwin),
      baseline: `same pairs, current reads: ${ofN(sub.twoLooks.falseAlarmTwin.k, sub.twoLooks.falseAlarmTwin.n)}`,
      interval: wilsonText(sub.quoted.falseAlarmTwin.k, sub.quoted.falseAlarmTwin.n),
      n: sub.quoted.falseAlarmTwin.n,
      script: SCRIPT,
      negative: sub.quoted.falseAlarmTwin.k > sub.twoLooks.falseAlarmTwin.k,
      note: `${SYNTH}. ${subNote} Disagreeing modules on matching pairs, current reads -> quoted reads: ${['damage', 'identity', 'colour', 'size'].map((m) => `${m} ${sub.twoLooks.falseAlarmTwinByModule[m] ?? 0} -> ${sub.quoted.falseAlarmTwinByModule[m] ?? 0}`).join(', ')}. Reads that counted as "not sure" for want of a citation: identity ${uncited.identity}, damage ${uncited.damage} (on matching pairs ${uncited.identityOnMatch} and ${uncited.damageOnMatch}).`,
    },
    {
      id: 'quoted-recall-false-alarms',
      label: 'Quoted reads (with two looks): mismatches flagged / false alarms',
      value: `${slash(sub.quoted.mismatchRecall)} · ${slash(sub.quoted.falseAlarm)}`,
      baseline: `same pairs, current reads: ${slash(sub.twoLooks.mismatchRecall)} · ${slash(sub.twoLooks.falseAlarm)}`,
      n,
      script: SCRIPT,
      negative: sub.quoted.mismatchRecall.k < sub.twoLooks.mismatchRecall.k,
      note: `${SYNTH}. ${subNote} Both columns use the two-looks rule; the current rule on the same pairs: ${slash(sub.current.mismatchRecall)} · ${slash(sub.current.falseAlarm)}. Per type (quoted): ${Object.entries(sub.quoted.perType).map(([k, v]) => `${k} ${ofN(v.k, v.n)}`).join(', ')}.`,
    },
    {
      id: 'retake-recall-false-alarms',
      label: 'After one SIMULATED retake: mismatches flagged / false alarms',
      value: `${slash(sub.quotedRetake.mismatchRecall)} · ${slash(sub.quotedRetake.falseAlarm)}`,
      baseline: `before it, same pairs: ${slash(sub.quoted.mismatchRecall)} · ${slash(sub.quoted.falseAlarm)}`,
      interval: wilsonText(sub.quotedRetake.mismatchRecall.k, sub.quotedRetake.mismatchRecall.n),
      n,
      script: SCRIPT,
      note: `${SIM}. ${SYNTH}. ${subNote} Quoted reads and two looks, then one extra photo for every "not sure" pair that asked for one. Current numbers on the same pairs: ${slash(sub.current.mismatchRecall)} · ${slash(sub.current.falseAlarm)}. Per type after the retake: ${Object.entries(sub.quotedRetake.perType).map(([k, v]) => `${k} ${ofN(v.k, v.n)}`).join(', ')}.`,
    },
    {
      id: 'retake-abstain-accuracy',
      label: 'After one SIMULATED retake: "not sure" / accuracy when it answers',
      value: `${slash(sub.quotedRetake.abstention)} · ${slash(sub.quotedRetake.accuracyWhenDecided)}`,
      baseline: `before it, same pairs: ${slash(sub.quoted.abstention)} · ${slash(sub.quoted.accuracyWhenDecided)}`,
      n,
      script: SCRIPT,
      note: `${SIM}. ${SYNTH}. Extra photos asked for: ${Object.entries(retakesAsked).map(([k, v]) => `${k} ${v}`).join(', ')}. Answers that changed: ${Object.entries(moves).map(([k, v]) => `${k} ${v}`).join('; ') || 'none'}. Current numbers on the same pairs: ${slash(sub.current.abstention)} · ${slash(sub.current.accuracyWhenDecided)}.`,
    },
    {
      id: 'colour-caught',
      label: 'Colour mismatches caught: current / two looks / quoted / after one SIMULATED retake',
      value: `${slash(cu.perType.colour!)} · ${slash(tl.perType.colour!)} · ${slash(sub.quoted.perType.colour!)} · ${slash(sub.quotedRetake.perType.colour!)}`,
      n: cu.perType.colour!.n,
      script: SCRIPT,
      negative: true,
      note: `${SYNTH}. The first two are on the whole test split, the last two on the ${n}-pair subset. ${SIM} for the last. A sure colour mismatch needs the colour seen as wrong on two photos (or a second module agreeing); a first photo the colour check gave up on (dim light, tinted light, wood) plus one better photo is still one look. Colour also asks for a photo in better light rather than white paper when the light was dim or tinted (decided on dev, see README).`,
    },
    {
      id: 'api-spend',
      label: 'Anthropic API spend on new reads for these results (dev and test)',
      value: `${t.spend.ledgerUsd.toFixed(2)} USD, ${t.spend.ledgerCalls} calls`,
      baseline: `cap: ${t.spend.capUsd} USD`,
      script: SCRIPT,
      note: `${t.model}, effort ${t.effort ?? 'default'}, prompt version ${t.promptVersion}, from the API's token counts at list price (${Object.entries(t.spend.prices).map(([m, [i, o]]) => `${m} ${i}/${o} USD per million input/output tokens`).join('; ')}). Size-tag reads were reused from the saved run where the tag photo was the same.`,
    },
  ];

  const limitations = [
    `${SYNTH}. Real photos will differ; the real photo set (evals/sightbench/real/SHOTLIST.md) is not collected yet.`,
    `Retakes are SIMULATED. SightBench has one photo of each delivered item, so each extra photo is rendered by evals/sightbench/py/sightbench/retake.py from the pair's own seed (the same item and damage, checked byte for byte against the pair's photo): "light" is a new day-light photo, "paper" a new photo under the pair's own light with an A4 sheet of white paper beside the item, "tag" the pair's own tag under its own light, closer and flatter. No number here says how real buyers' retakes would go.`,
    `The two-looks rows use all ${rows.length} test pairs and the module outputs saved by the last with-model test run; re-fusing them with the old rule reproduced every saved verdict (${replayed.length} of ${replayed.length}).`,
    `Quoted reads and retakes need new model calls, capped at about 12 USD, so they cover a stratified subset of ${n} test pairs, not all 420. Intervals on the subset are wide. Cells: ${Object.entries(cells).sort().map(([k, v]) => `${k} ${v}`).join(', ')}.`,
    'Nothing was fitted on test. The citation rules (which words name a region, which descriptions are hedges) and the retake choice were written and checked on the dev split only; the two-looks rule has no threshold.',
    'The test split has now been scored with the two-looks rule once, with quoted reads once and with a simulated retake once, in one run (details.run).',
    ...(t.stopped ? [`The test run stopped early: ${t.stopped}.`] : []),
  ];

  writeResult('sightbench-looks', {
    title: 'SightBench: two looks before "sure", quoted reads, one extra photo',
    headlines,
    limitations,
    details: {
      label: `${SYNTH}. Retakes are simulated.`,
      run: { rowsFile: path.relative(EVALS_DIR, ROWS), generatedAt: t.generatedAt, thresholds: t.thresholds, promptVersion: t.promptVersion, model: t.model, effort: t.effort, stopped: t.stopped },
      freeze: { sha256: freeze.sha256 },
      spend: t.spend,
      fullTestSplit: full,
      subset: { n, ids: t.sample, notRun, cells, scores: sub, retakesAsked, answerChanges: moves, uncited },
      dev: devScores ? { ...devScores, spendNote: 'Dev reads are included in the spend above.', generatedAt: dev!.generatedAt } : null,
      rows: rows.map((r) => ({
        id: r.id,
        expected: r.expected,
        mismatchType: r.mismatchType,
        lighting: r.lighting,
        current: r.current?.kind,
        twoLooks: r.twoLooks?.kind,
        twoLooksRetake: r.twoLooks?.retake ?? null,
        ...(r.quoted ? { quoted: r.quoted.kind, retakeAsked: r.quoted.retake, afterRetake: r.quotedRetake?.kind } : {}),
      })),
    },
  });
  console.log('looks: wrote evals/results/sightbench-looks.json');
}

main();
