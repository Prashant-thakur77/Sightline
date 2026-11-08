import 'server-only';
import { loadSuites } from './stats';

/** Short labels for featured results; values and baselines always come from the eval files. */
const PICKS: { suite: string; id: string; label: string; baselineLabel: string; baselineFrom?: string }[] = [
  { suite: 'redteam', id: 'breaches-sightline', label: 'payments that went wrong across 60 poisoned listings', baselineLabel: 'An agent without the gate' },
  { suite: 'confirmation', id: 'combined-false-confirm', label: 'times it took a non-confirmation as “yes”, out of 266 phrases', baselineLabel: 'A keyword matcher' },
  {
    suite: 'duplicates',
    id: 'duplicate-scenarios',
    label: 'double-charge scenarios that ended with two orders',
    baselineLabel: 'Before we fixed lost PayPal answers',
    baselineFrom: 'duplicate-scenarios-before-fix',
  },
  { suite: 'grounding', id: 'catch-rate', label: 'invented product claims caught before being spoken', baselineLabel: 'With no guard' },
  { suite: 'sightbench', id: 'mismatch-recall', label: 'wrong items the camera check caught', baselineLabel: 'Image-similarity baseline' },
  { suite: 'barrier', id: 'keyboard-fail', label: 'stores where a keyboard could not reach “Add to cart”', baselineLabel: 'Sightline path' },
];

export interface Featured {
  id: string;
  value: string;
  label: string;
  baseline?: string;
  script: string;
}

export async function featuredHeadlines(max = 4): Promise<Featured[]> {
  const suites = await loadSuites();
  const out: Featured[] = [];
  for (const p of PICKS) {
    const suite = suites.find((s) => s.suite === p.suite);
    const h = suite?.headlines.find((x) => x.id === p.id);
    if (!h) continue;
    const base = p.baselineFrom ? suite?.headlines.find((x) => x.id === p.baselineFrom)?.value : h.baseline?.split(':').pop()?.trim();
    out.push({ id: p.id, value: h.value, label: p.label, baseline: base ? `${p.baselineLabel}: ${base}` : undefined, script: h.script });
    if (out.length >= max) break;
  }
  return out;
}
