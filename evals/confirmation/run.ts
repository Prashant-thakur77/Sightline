/**
 * Confirmation suite: the key-1 phrase matcher (matchConfirmationPhrase) on the 200-utterance
 * development fixture and on a held-out set written before the matcher was run on it.
 *
 *   false confirm = the matcher says "confirm" for an utterance not meant as a confirmation
 *   false reject  = the matcher does not say "confirm" for an utterance meant as one
 *
 * Baseline: a naive matcher that confirms when the lower-cased text contains "yes", "confirm" or
 * "buy" anywhere (substring match, the way a keyword check is usually written).
 *
 * Key 2 (the model classifier) needs ANTHROPIC_API_KEY and is not run here. The full two-key
 * state machine (decideConfirmation) is run with key 2 stubbed to always agree, which is the
 * worst case for false confirms, to show the wiring adds no confirmations of its own.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { decideConfirmation, matchConfirmationPhrase, normaliseText, type ConfirmationClassifier } from '@sightline/agent';
import { usd } from '../lib/commerce';
import { REPO_ROOT, ofN, scriptPath, writeResult, type Headline } from '../lib/results';
import { pct, wilson, wilsonText } from '../lib/stats';

const SCRIPT = scriptPath(import.meta.url);

interface Row {
  utterance: string;
  category: string;
  intent: 'confirm' | 'not_confirm' | 'ambiguous';
  transcriptMeaning?: 'confirm';
  note?: string;
}

const devPath = 'packages/agent/test/fixtures/confirmations.json';
const heldoutPath = 'evals/confirmation/heldout.json';
const dev = JSON.parse(readFileSync(path.join(REPO_ROOT, devPath), 'utf8')) as Row[];
const heldoutFile = JSON.parse(readFileSync(path.join(REPO_ROOT, heldoutPath), 'utf8')) as { protocol: string[]; rows: Row[] };
const heldout = heldoutFile.rows;

const key1 = (u: string) => matchConfirmationPhrase(u, { phase: 'readback' });
/** Baseline: confirms if the text contains "yes", "confirm" or "buy". */
export const naiveConfirms = (u: string): boolean => {
  const t = normaliseText(u);
  return t.includes('yes') || t.includes('confirm') || t.includes('buy');
};

interface Scored {
  n: number;
  k: number;
  rate: string;
  interval: [number, number];
  items: { utterance: string; category: string; decision?: string; reason?: string }[];
}

function score(rows: Row[], pick: (r: Row) => boolean, bad: (r: Row) => boolean, label: (r: Row) => { decision?: string; reason?: string }): Scored {
  const pool = rows.filter(pick);
  const hits = pool.filter(bad);
  return {
    n: pool.length,
    k: hits.length,
    rate: pct(hits.length / pool.length),
    interval: wilson(hits.length, pool.length),
    items: hits.map((r) => ({ utterance: r.utterance, category: r.category, ...label(r) })),
  };
}

function evaluate(rows: Row[]) {
  const notMeant = (r: Row) => r.intent !== 'confirm' && r.transcriptMeaning !== 'confirm';
  const meant = (r: Row) => r.intent === 'confirm';
  const identical = (r: Row) => r.transcriptMeaning === 'confirm';
  const k1 = (r: Row) => key1(r.utterance);
  const k1Label = (r: Row) => ({ decision: k1(r).decision, reason: k1(r).reason });
  const nvLabel = (r: Row) => ({ decision: naiveConfirms(r.utterance) ? 'confirm' : 'none' });

  const byCategory: Record<string, { n: number; key1Confirms: number; naiveConfirms: number; intents: Record<string, number> }> = {};
  for (const r of rows) {
    const c = (byCategory[r.category] ??= { n: 0, key1Confirms: 0, naiveConfirms: 0, intents: {} });
    c.n++;
    c.intents[r.intent] = (c.intents[r.intent] ?? 0) + 1;
    if (k1(r).decision === 'confirm') c.key1Confirms++;
    if (naiveConfirms(r.utterance)) c.naiveConfirms++;
  }
  const falseRejectsByCategory: Record<string, string> = {};
  for (const cat of Object.keys(byCategory)) {
    const meantHere = rows.filter((r) => r.category === cat && r.intent === 'confirm');
    if (meantHere.length === 0) continue;
    falseRejectsByCategory[cat] = ofN(meantHere.filter((r) => k1(r).decision !== 'confirm').length, meantHere.length);
  }
  const decisions: Record<string, number> = {};
  for (const r of rows) decisions[k1(r).decision] = (decisions[k1(r).decision] ?? 0) + 1;

  return {
    size: rows.length,
    key1: {
      falseConfirm: score(rows, notMeant, (r) => k1(r).decision === 'confirm', k1Label),
      falseReject: score(rows, meant, (r) => k1(r).decision !== 'confirm', k1Label),
      decisions,
    },
    naive: {
      falseConfirm: score(rows, notMeant, (r) => naiveConfirms(r.utterance), nvLabel),
      falseReject: score(rows, meant, (r) => !naiveConfirms(r.utterance), nvLabel),
    },
    transcriptIdentical: rows.some(identical)
      ? {
          key1: score(rows, identical, (r) => k1(r).decision === 'confirm', k1Label),
          naive: score(rows, identical, (r) => naiveConfirms(r.utterance), nvLabel),
          rows: rows.filter(identical).map((r) => ({ utterance: r.utterance, note: r.note ?? '' })),
        }
      : null,
    byCategory,
    falseRejectsByCategory,
  };
}

/** Run the real state machine over every utterance with key 2 stubbed. */
async function twoKeyWiring(rows: Row[], label: 'confirm' | 'not_confirm') {
  const stub: ConfirmationClassifier = { classify: async () => ({ label, rationale: `stub: always ${label}` }) };
  const readback = { text: 'Stub readback for the wiring check.', textHash: 'stub-readback', total: usd(3672) };
  let confirmedNotMeant = 0;
  let confirmedMeant = 0;
  let notMeantN = 0;
  let meantN = 0;
  for (const [i, r] of rows.entries()) {
    const d = await decideConfirmation({ phrase: r.utterance, classifier: stub, buttonPressed: false, readback, now: 1_700_000_000_000 + i });
    const confirmed = d.outcome === 'confirmed';
    if (r.intent === 'confirm') {
      meantN++;
      if (confirmed) confirmedMeant++;
    } else if (r.transcriptMeaning !== 'confirm') {
      notMeantN++;
      if (confirmed) confirmedNotMeant++;
    }
  }
  return { key2Stub: label, falseConfirms: ofN(confirmedNotMeant, notMeantN), intendedConfirmed: ofN(confirmedMeant, meantN) };
}

async function main() {
  const devR = evaluate(dev);
  const hoR = evaluate(heldout);
  const both = evaluate([...dev, ...heldout]);
  const wiring = {
    heldout: [await twoKeyWiring(heldout, 'confirm'), await twoKeyWiring(heldout, 'not_confirm')],
    dev: [await twoKeyWiring(dev, 'confirm'), await twoKeyWiring(dev, 'not_confirm')],
  };

  const fc = hoR.key1.falseConfirm;
  const fr = hoR.key1.falseReject;
  const dfc = devR.key1.falseConfirm;
  const ti = hoR.transcriptIdentical!;
  const allFc = both.key1.falseConfirm;

  const headlines: Headline[] = [
    {
      id: 'heldout-false-confirm',
      label: 'False confirms, key-1 phrase matcher, held-out utterances',
      value: ofN(fc.k, fc.n),
      baseline: `naive keyword match: ${ofN(hoR.naive.falseConfirm.k, hoR.naive.falseConfirm.n)}`,
      interval: wilsonText(fc.k, fc.n),
      n: fc.n,
      script: SCRIPT,
      note: 'Held-out set written before the matcher was run on it. Target is 0.',
    },
    {
      id: 'dev-false-confirm',
      label: 'False confirms, key-1 phrase matcher, 200-utterance development fixture',
      value: ofN(dfc.k, dfc.n),
      baseline: `naive keyword match: ${ofN(devR.naive.falseConfirm.k, devR.naive.falseConfirm.n)}`,
      interval: wilsonText(dfc.k, dfc.n),
      n: dfc.n,
      script: SCRIPT,
      note: 'The matcher was developed against this fixture, so it is not an independent test.',
    },
    {
      id: 'heldout-false-reject',
      label: 'Intended confirmations the matcher rejects, held-out utterances',
      value: `${ofN(fr.k, fr.n)} (${fr.rate})`,
      baseline: `naive keyword match: ${ofN(hoR.naive.falseReject.k, hoR.naive.falseReject.n)}`,
      interval: wilsonText(fr.k, fr.n),
      n: fr.n,
      script: SCRIPT,
      negative: true,
      note: `Strict by design; each reject is answered with how to confirm. Plain English confirmations rejected: ${hoR.falseRejectsByCategory.clear_confirm}; other languages: ${hoR.falseRejectsByCategory.other_language}; misheard words: ${hoR.falseRejectsByCategory.asr_error}.`,
    },
    {
      id: 'transcript-identical',
      label: 'Background speech or misrecognition that yields an exact allowed phrase',
      value: `${ofN(ti.key1.k, ti.key1.n)} confirmed by key 1`,
      baseline: `naive keyword match: ${ofN(ti.naive.k, ti.naive.n)}`,
      interval: wilsonText(ti.key1.k, ti.key1.n),
      n: ti.key1.n,
      script: SCRIPT,
      negative: true,
      note: 'A text check cannot tell "confirm purchase" from a TV or a dropped "don\'t". Push-to-talk limits this; the classifier sees the same text.',
    },
    {
      id: 'combined-false-confirm',
      label: 'False confirms, key-1 matcher, development and held-out combined',
      value: ofN(allFc.k, allFc.n),
      baseline: `naive keyword match: ${ofN(both.naive.falseConfirm.k, both.naive.falseConfirm.n)}`,
      interval: wilsonText(allFc.k, allFc.n),
      n: allFc.n,
      script: SCRIPT,
    },
  ];

  const plainRejected = fr.items.filter((i) => i.category === 'clear_confirm');
  const plainMeant = heldout.filter((r) => r.category === 'clear_confirm' && r.intent === 'confirm').length;
  const limitations = [
    `Plain-English intended confirmations rejected on the held-out set (${ofN(plainRejected.length, plainMeant)}): ${plainRejected.map((i) => `"${i.utterance}" (${i.reason})`).join(', ')}. Each gets the reply telling the buyer to say "confirm purchase"; widening the phrase list would have to keep the false-confirm count at zero.`,
    'Key 2 (the model classifier) not run: needs ANTHROPIC_API_KEY. Every number is for key 1 alone. A spoken confirmation needs both keys, so the two-key false-confirm rate cannot be higher than key 1\'s; the state machine was also run with key 2 stubbed to always agree and produced the same false confirms as key 1 alone.',
    'Held-out utterances were written by an author who had read the matcher source and the development fixture. They were held out from tuning, not written blind by a third party.',
    'Text transcripts only. No audio and no real speech recogniser: the misrecognitions are hand-written imitations.',
    `With n = ${fc.n}, zero observed false confirms is still compatible with a true rate up to the upper end of the interval.`,
  ];

  writeResult('confirmation', {
    title: 'Spoken purchase confirmation',
    headlines,
    limitations,
    details: {
      design: {
        keys: 'Key 1: deterministic phrase matcher (matchConfirmationPhrase) or the Confirm button. Key 2: a model classifier that must also label the same utterance "confirm". Button-only path: two deliberate presses at least 500 ms apart.',
        stateMachine: 'decideConfirmation in packages/agent/src/confirm.ts; hold, cancel and change always win; questions, conditionals, reported speech, hesitation and other languages veto even a button press.',
        key2Status: 'not run: needs ANTHROPIC_API_KEY',
      },
      baseline: 'naive: lower-cased text contains "yes", "confirm" or "buy" (substring).',
      scoring: heldoutFile.protocol,
      sources: { dev: devPath, heldout: heldoutPath },
      heldout: hoR,
      dev: devR,
      combined: { falseConfirm: both.key1.falseConfirm, naiveFalseConfirm: both.naive.falseConfirm },
      twoKeyWiring: wiring,
    },
  });

  console.log(`confirmation: held-out false confirm ${ofN(fc.k, fc.n)}, false reject ${ofN(fr.k, fr.n)}, transcript-identical ${ofN(ti.key1.k, ti.key1.n)}; dev false confirm ${ofN(dfc.k, dfc.n)}`);
}

await main();
