import 'server-only';
import { loadSuites, type Headline, type SuiteResult } from './stats';

/*
 * The featured results on the landing and judge pages. Labels are short words of ours; every value,
 * count, baseline and caveat is read from the eval result files, so a card can never say more than
 * the file does. A label only names how a number was measured when the file says so.
 */

/** Text after the first ":" of a baseline, e.g. "naive keyword match: 132 of 266" -> "132 of 266". */
const baselineValue = (b?: string) => b?.split(':').pop()?.trim() || undefined;

/** The first clause of a note, up to ";" or ".", e.g. "Local ledger simulation". */
const firstClause = (note?: string) => note?.split(/[;.]/)[0]?.trim() ?? '';

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** "417 of 420 (99.3%)" + "pairs" -> "417 of 420 pairs (99.3%)"; any other shape is left as it is. */
const counted = (value: string, noun: string) => {
  const m = /^(\d+ of \d+)(\s*\(.*\))?$/.exec(value.trim());
  return m ? `${m[1]} ${noun}${m[2] ?? ''}` : value;
};

interface Pick {
  suite: string;
  id: string;
  /** Our short label, built from the result so its counts and method come from the file. */
  label: (h: Headline, s: SuiteResult) => string;
  /** Who the baseline is, in our words. The baseline's value always comes from the file. */
  baselineLabel?: string;
  /** One or two plain sentences of context, built from the result file. */
  context?: (h: Headline, s: SuiteResult) => string | undefined;
}

const PICKS: Pick[] = [
  {
    suite: 'redteam',
    id: 'breaches-sightline',
    label: (h) => {
      const how = firstClause(h.note);
      return `payments that went wrong across ${h.n ?? 'the'} listings written to trick the app${/simulation/i.test(how) ? `, in a ${lowerFirst(how)}` : ''}`;
    },
    baselineLabel: 'A shopping agent without the payment check',
  },
  {
    suite: 'confirmation',
    id: 'combined-false-confirm',
    label: (h) => `times something that was not a “yes” was taken as one, out of ${h.n ?? 'the'} typed phrases`,
    baselineLabel: 'Listening only for key words',
  },
  {
    suite: 'duplicates',
    id: 'duplicate-scenarios',
    label: (h) => `double-charge tests (double taps, retries, lost replies) that ended with more than one order${/no PayPal call is made/i.test(h.note ?? '') ? ', simulated without calling PayPal' : ''}`,
    // The baseline the suite declares on this headline, not a hand-picked comparison.
    baselineLabel: 'Sending every retry as a new payment',
  },
  {
    suite: 'grounding',
    id: 'catch-rate',
    label: (h) => `made-up product facts caught before you heard them${/^simulated: scripted answers/i.test(h.note ?? '') ? ', in scripted test answers' : ''}`,
    baselineLabel: 'With no fact check',
  },
  {
    suite: 'sightbench',
    id: 'mismatch-recall',
    label: () => 'wrong items the camera check caught',
    baselineLabel: 'A general image-matching model',
    context: (_h, s) => {
      const label = (s as SuiteResult & { details?: { label?: string } }).details?.label ?? '';
      const how = [/synthetic renders/i.test(label) && 'Synthetic renders', /without vision-model reads/i.test(label) && 'no vision-model reads']
        .filter(Boolean)
        .join(', ');
      const abstained = s.headlines.find((x) => x.id === 'abstention')?.value;
      const clipFalseAlarms = baselineValue(s.headlines.find((x) => x.id === 'false-alarms')?.baseline);
      return [
        abstained && `${how ? `${how}: ` : ''}it answered “not sure” for ${counted(abstained, 'pairs')}.`,
        clipFalseAlarms && `The baseline also flags ${counted(clipFalseAlarms, 'correct items')} as wrong.`,
      ]
        .filter(Boolean)
        .map((t) => (t as string).charAt(0).toUpperCase() + (t as string).slice(1))
        .join(' ') || undefined;
    },
  },
  {
    suite: 'barrier',
    id: 'barrier-keyboard-atc-unreachable',
    label: () => 'stores where pressing Tab could not reach “Add to cart”',
  },
];

export interface Featured {
  id: string;
  value: string;
  label: string;
  baseline?: string;
  script: string;
  /** The result file marks this as a negative result. */
  negative?: boolean;
  /** Plain sentences of context, read from the result file. */
  context?: string;
}

export async function featuredHeadlines(max = 4): Promise<Featured[]> {
  const suites = await loadSuites();
  const out: Featured[] = [];
  for (const p of PICKS) {
    const suite = suites.find((s) => s.suite === p.suite);
    const h = suite?.headlines.find((x) => x.id === p.id);
    if (!suite || !h) {
      // A renamed headline id would silently drop its card: say so while developing.
      if (process.env.NODE_ENV !== 'production')
        console.warn(`[headlines] featured result ${p.suite}/${p.id} is missing from evals/results; its card is not shown.`);
      continue;
    }
    const base = baselineValue(h.baseline);
    out.push({
      id: p.id,
      value: h.value,
      label: p.label(h, suite),
      baseline: base && p.baselineLabel ? `${p.baselineLabel}: ${base}` : undefined,
      script: h.script,
      negative: h.negative === true || undefined,
      context: p.context?.(h, suite),
    });
    if (out.length >= max) break;
  }
  return out;
}
