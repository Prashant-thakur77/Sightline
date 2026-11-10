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
 *
 * Press rule: a spoken confirmation only counts while the buyer holds Talk, or after Confirm was
 * pressed for the readback. Background speech (a TV, a radio) is modelled as arriving with no
 * press; misrecognitions of the buyer's own words are modelled as held, since the buyer was
 * talking to us. Both go through the real state machine with key 2 stubbed to always agree.
 *
 * "Before" numbers come from evals/confirmation/before.json: the values this script wrote before
 * the press rule and the widened phrases, with the run time and git commit they came from.
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
const beforePath = 'evals/confirmation/before.json';
const before = JSON.parse(readFileSync(path.join(REPO_ROOT, beforePath), 'utf8')) as {
  ranAt: string;
  gitSha: string;
  heldoutFalseReject: string;
  devFalseReject: string;
  transcriptIdentical: string;
};
const beforeAt = 'before';
const beforeFrom = `"Before" is from the run of ${before.ranAt} at git ${before.gitSha} (${beforePath}).`;

/** Categories that are speech from a TV, radio or someone else in the room, not the buyer talking to us. */
const BACKGROUND = new Set(['background_tv', 'background_tv_exact']);

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

/** Run the real state machine over every utterance with key 2 stubbed, every utterance arriving held (the worst case). */
async function twoKeyWiring(rows: Row[], label: 'confirm' | 'not_confirm') {
  const stub: ConfirmationClassifier = { classify: async () => ({ label, rationale: `stub: always ${label}` }) };
  const readback = { text: 'Stub readback for the wiring check.', textHash: 'stub-readback', total: usd(3672) };
  let confirmedNotMeant = 0;
  let confirmedMeant = 0;
  let notMeantN = 0;
  let meantN = 0;
  for (const [i, r] of rows.entries()) {
    const d = await decideConfirmation({ phrase: r.utterance, classifier: stub, buttonPressed: false, capture: 'held', readback, now: 1_700_000_000_000 + i });
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

/**
 * The press rule over the real state machine, key 2 stubbed to always agree (the worst case).
 * Background speech arrives with no press; the buyer's own misheard words arrive held.
 */
async function pressRule(rows: Row[]) {
  const stub: ConfirmationClassifier = { classify: async () => ({ label: 'confirm', rationale: 'stub: always confirm' }) };
  const readback = { text: 'Stub readback for the press check.', textHash: 'stub-readback', total: usd(3672) };
  const run = async (r: Row, capture: 'open' | 'held', i: number) =>
    (await decideConfirmation({ phrase: r.utterance, classifier: stub, buttonPressed: false, capture, readback, now: 1_700_000_000_000 + i })).outcome;
  const background = rows.filter((r) => BACKGROUND.has(r.category));
  const misheard = rows.filter((r) => r.transcriptMeaning === 'confirm' && !BACKGROUND.has(r.category));
  const bgOut = await Promise.all(background.map((r, i) => run(r, 'open', i)));
  const misOut = await Promise.all(misheard.map((r, i) => run(r, 'held', i)));
  const exactBg = background.filter((r) => r.transcriptMeaning === 'confirm');
  return {
    background: {
      n: background.length,
      confirmed: bgOut.filter((o) => o === 'confirmed').length,
      key1TextAloneConfirms: background.filter((r) => key1(r.utterance).decision === 'confirm').length,
      exactPhrase: {
        n: exactBg.length,
        confirmed: exactBg.filter((r) => bgOut[background.indexOf(r)] === 'confirmed').length,
        toldHowToConfirm: exactBg.filter((r) => bgOut[background.indexOf(r)] === 'needs_press').length,
      },
    },
    misheardHeld: {
      n: misheard.length,
      confirmed: misOut.filter((o) => o === 'confirmed').length,
      rows: misheard.map((r, i) => ({ utterance: r.utterance, note: r.note ?? '', outcome: misOut[i] })),
    },
  };
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
  const press = { heldout: await pressRule(heldout), dev: await pressRule(dev) };
  const hp = press.heldout;
  const tiAfter = hp.background.exactPhrase.confirmed + hp.misheardHeld.confirmed;
  const dfr = devR.key1.falseReject;
  const bgN = hp.background.n + press.dev.background.n;
  const bgConfirmed = hp.background.confirmed + press.dev.background.confirmed;

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
      baseline: `${beforeAt}: ${before.heldoutFalseReject}; naive: ${ofN(hoR.naive.falseReject.k, hoR.naive.falseReject.n)}`,
      interval: wilsonText(fr.k, fr.n),
      n: fr.n,
      script: SCRIPT,
      negative: true,
      note: `${beforeFrom} Target was under 10%; not reached. Phrases were widened only from the development fixture's rejected cases (development rejects ${before.devFalseReject} before, ${ofN(dfr.k, dfr.n)} now). Plain English confirmations rejected: ${hoR.falseRejectsByCategory.clear_confirm}; polite requests: ${hoR.falseRejectsByCategory.polite}; other languages: ${hoR.falseRejectsByCategory.other_language}; misheard words: ${hoR.falseRejectsByCategory.asr_error}. The development fixture has no misheard words, so nothing was added for them. Each reject is answered with how to confirm.`,
    },
    {
      id: 'transcript-identical',
      label: 'Background speech or misrecognition that yields an exact allowed phrase, with the press rule',
      value: `${ofN(tiAfter, ti.key1.n)} confirmed`,
      baseline: `${beforeAt}: ${before.transcriptIdentical.replace(/ confirmed.*$/, '')} (text alone); naive: ${ofN(ti.naive.k, ti.naive.n)}`,
      interval: wilsonText(tiAfter, ti.key1.n),
      n: ti.key1.n,
      script: SCRIPT,
      negative: tiAfter > 0,
      note: `${beforeFrom} Background speech arrives with no press: ${ofN(hp.background.exactPhrase.confirmed, hp.background.exactPhrase.n)} confirmed, ${ofN(hp.background.exactPhrase.toldHowToConfirm, hp.background.exactPhrase.n)} told how to confirm. Misrecognitions of the buyer's own words, spoken while holding Talk: ${ofN(hp.misheardHeld.confirmed, hp.misheardHeld.n)} confirmed. The press rule cannot catch those, and key 2 sees the same text.`,
    },
    {
      id: 'background-no-press',
      label: 'All background speech arriving with no press, two-key state machine with key 2 always agreeing',
      value: `${ofN(bgConfirmed, bgN)} confirmed`,
      baseline: `key 1 text alone: ${ofN(hp.background.key1TextAloneConfirms + press.dev.background.key1TextAloneConfirms, bgN)}`,
      interval: wilsonText(bgConfirmed, bgN),
      n: bgN,
      script: SCRIPT,
      note: `Held-out ${ofN(hp.background.confirmed, hp.background.n)}, development ${ofN(press.dev.background.confirmed, press.dev.background.n)}. The press is what the client reports and the server enforces; a TV speaking while the buyer holds Talk is not covered.`,
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
    'Other languages: only phrases from the development fixture were added, and only next to a confirmation phrase ("haan, confirm", "sí, compra", "confirmar compra"). A bare foreign yes ("sí", "haan", "oui") stays rejected, as a bare English "yes" does, and non-Latin scripts stay rejected.',
    'The press rule trusts the client to report whether Talk was held. The server treats a missing report as not pressed; a modified client could still claim a press.',
    plainRejected.length === 0
      ? `Plain-English intended confirmations rejected on the held-out set: ${ofN(0, plainMeant)}. The rejects left are polite forms not in the development fixture, other languages and misheard words.`
      : `Plain-English intended confirmations rejected on the held-out set (${ofN(plainRejected.length, plainMeant)}): ${plainRejected.map((i) => `"${i.utterance}" (${i.reason})`).join(', ')}. Each gets the reply telling the buyer to say "confirm purchase"; widening the phrase list would have to keep the false-confirm count at zero.`,
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
        pressRule: 'A spoken phrase is key 1 only when captured while Talk was held, typed, or said after Confirm was pressed for this readback. The client sends capture; the server treats a missing value as not pressed.',
        keys: 'Key 1: deterministic phrase matcher (matchConfirmationPhrase) or the Confirm button. Key 2: a model classifier that must also label the same utterance "confirm". Button-only path: two deliberate presses at least 500 ms apart.',
        stateMachine: 'decideConfirmation in packages/agent/src/confirm.ts; hold, cancel and change always win; questions, conditionals, reported speech, hesitation and other languages veto even a button press.',
        key2Status: 'not run: needs ANTHROPIC_API_KEY',
      },
      baseline: 'naive: lower-cased text contains "yes", "confirm" or "buy" (substring).',
      scoring: heldoutFile.protocol,
      sources: { dev: devPath, heldout: heldoutPath, before: beforePath },
      before,
      pressRule: press,
      heldout: hoR,
      dev: devR,
      combined: { falseConfirm: both.key1.falseConfirm, naiveFalseConfirm: both.naive.falseConfirm },
      twoKeyWiring: wiring,
    },
  });

  console.log(`confirmation: held-out false confirm ${ofN(fc.k, fc.n)}, false reject ${ofN(fr.k, fr.n)}, transcript-identical with press rule ${ofN(tiAfter, ti.key1.n)}, background no press ${ofN(bgConfirmed, bgN)}; dev false confirm ${ofN(dfc.k, dfc.n)}`);
}

await main();
