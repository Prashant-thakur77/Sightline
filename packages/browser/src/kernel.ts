import Kernel from '@onkernel/sdk';
import robotsParser from 'robots-parser';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { BrowserNotConfiguredError, USER_AGENT, type PageRead, type PageReader } from './types';

const require = createRequire(import.meta.url);

export class RobotsDisallowedError extends Error {
  constructor(url: string) {
    super(`robots.txt disallows reading ${url}`);
    this.name = 'RobotsDisallowedError';
  }
}

/** Fetch robots.txt and decide whether a read-only visit to `url` is allowed. Unreachable robots.txt allows. */
export async function robotsAllows(url: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  const u = new URL(url);
  const robotsUrl = `${u.protocol}//${u.host}/robots.txt`;
  try {
    const res = await fetcher(robotsUrl, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return true;
    const robots = robotsParser(robotsUrl, await res.text());
    return robots.isAllowed(url, USER_AGENT) !== false;
  } catch {
    return true;
  }
}

function normalise(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Keep only quotes that occur verbatim (whitespace/case-insensitive) in the page text. */
export function verifyQuotes(text: string, answers: { question: string; quote: string | null }[]) {
  const hay = normalise(text);
  return answers.map((a) => ({ question: a.question, quote: a.quote && hay.includes(normalise(a.quote)) ? a.quote : null }));
}

const KEYWORDS: Record<string, RegExp> = {
  returns: /\b(return|returns|refund|exchange)\b/i,
  sizing: /\b(size|sizing|fit|fits|runs (small|large)|true to size)\b/i,
  material: /\b(cotton|wool|polyester|nylon|leather|linen|material|fabric|%)\b/i,
  shipping: /\b(ship|shipping|delivery|deliver)\b/i,
  care: /\b(wash|dry clean|tumble|iron|care)\b/i,
};

/** Deterministic quote picker: the first short sentence on the page that matches the topic. */
export function pickQuotes(text: string, questions: string[]): { question: string; quote: string | null }[] {
  const sentences = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12 && s.length <= 220);
  return questions.map((q) => {
    const topic = Object.keys(KEYWORDS).find((k) => q.toLowerCase().includes(k)) ?? Object.keys(KEYWORDS).find((k) => KEYWORDS[k]!.test(q));
    const re = topic ? KEYWORDS[topic]! : null;
    const hit = re ? sentences.find((s) => re.test(s)) : undefined;
    return { question: q, quote: hit ?? null };
  });
}

export interface KernelReaderOptions {
  apiKey: string;
  /** Run axe-core in the page and return violations. */
  audit?: boolean;
  screenshot?: boolean;
  onLiveView?: (url: string) => void;
}

/**
 * Reads one public page in a KERNEL cloud browser. Read-only: it navigates and reads; it never
 * clicks buy buttons or submits forms. Identifies itself with an honest user agent and checks
 * robots.txt first. No stealth or evasion.
 */
export function createKernelReader(opts: KernelReaderOptions): PageReader {
  if (!opts.apiKey) throw new BrowserNotConfiguredError();
  const kernel = new Kernel({ apiKey: opts.apiKey });
  let axeSource: string | null = null;
  return {
    async read(url: string, questions: string[]): Promise<PageRead> {
      if (!/^https:\/\//.test(url)) throw new Error('Only https pages are read');
      if (!(await robotsAllows(url))) throw new RobotsDisallowedError(url);
      if (opts.audit && !axeSource) axeSource = await readFile(require.resolve('axe-core/axe.min.js'), 'utf8');
      const browser = await kernel.browsers.create({ timeout_seconds: 120 } as never);
      const b = browser as unknown as { session_id: string; browser_live_view_url?: string };
      if (b.browser_live_view_url) opts.onLiveView?.(b.browser_live_view_url);
      try {
        const code = `
          await page.setExtraHTTPHeaders({ 'user-agent': ${JSON.stringify(USER_AGENT)} });
          await page.goto(${JSON.stringify(url)}, { waitUntil: 'domcontentloaded', timeout: 45000 });
          await page.waitForTimeout(2500);
          const title = await page.title();
          const text = await page.evaluate(() => document.body ? document.body.innerText : '');
          let axe = null;
          ${opts.audit ? `await page.addScriptTag({ content: ${JSON.stringify(axeSource)} });
          axe = await page.evaluate(async () => {
            const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a','wcag2aa','wcag21aa','wcag22aa'] } });
            return r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length }));
          });` : ''}
          const shot = ${opts.screenshot ? `(await page.screenshot({ type: 'png' })).toString('base64')` : 'null'};
          return { title, text: text.slice(0, 200000), axe, shot };
        `;
        const res = await kernel.browsers.playwright.execute(b.session_id, { code });
        if (!res.success) throw new Error(res.error ?? 'page read failed');
        const r = res.result as { title: string; text: string; axe: PageRead['axe'] extends infer A ? (A extends { violations: infer V } ? V : never) : never; shot: string | null };
        const answers = verifyQuotes(r.text, pickQuotes(r.text, questions));
        return {
          url,
          fetchedAt: new Date().toISOString(),
          title: r.title,
          text: r.text,
          answers,
          axe: r.axe ? { violations: r.axe } : undefined,
          archive: r.shot ? { screenshotPng: Uint8Array.from(Buffer.from(r.shot, 'base64')) } : undefined,
        };
      } finally {
        await kernel.browsers.deleteByID(b.session_id).catch(() => {});
      }
    },
  };
}
