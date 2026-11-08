/**
 * Every number the /judge page shows comes from a file written here by an eval script.
 * Shape (read by apps/web/src/server/stats.ts):
 *   { suite, title, ranAt, gitSha, headlines: [...], limitations?, details }
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Headline {
  id: string;
  label: string;
  /** Short human string, e.g. "0 of 60" or "0.0%". */
  value: string;
  baseline?: string;
  interval?: string;
  n?: number;
  /** Repo-relative path of the script that produced this number. */
  script: string;
  negative?: boolean;
  note?: string;
}

export interface SuitePayload {
  title: string;
  headlines: Headline[];
  limitations?: string[];
  details: unknown;
}

export interface SuiteResult extends SuitePayload {
  suite: string;
  ranAt: string;
  gitSha: string;
}

export const EVALS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = path.resolve(EVALS_DIR, '..');
export const RESULTS_DIR = path.join(EVALS_DIR, 'results');

/** Repo-relative path for a script, from its import.meta.url. */
export function scriptPath(metaUrl: string): string {
  return path.relative(REPO_ROOT, fileURLToPath(metaUrl)).split(path.sep).join('/');
}

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/**
 * Short SHA of HEAD, or 'uncommitted' when there is no commit or when the code that produces the
 * numbers (evals/ or packages/) differs from HEAD, so a SHA is never shown for code it does not
 * contain.
 */
/**
 * The code a result depends on: evals and packages, but not the result files themselves, which
 * every run rewrites (otherwise the first suite of a run would make every later one "uncommitted").
 */
export const CODE_PATHS = ['evals', 'packages', ':(exclude)evals/results', ':(exclude)evals/RESULTS.md'];

export function gitSha(): string {
  const sha = git(['rev-parse', '--short', 'HEAD']);
  if (!sha) return 'uncommitted';
  const dirty = git(['status', '--porcelain', '--', ...CODE_PATHS]);
  if (dirty === null || dirty.length > 0) return 'uncommitted';
  return sha;
}

export function sourceState(): { head: string | null; dirtyPaths: string[] } {
  const head = git(['rev-parse', '--short', 'HEAD']);
  const status = git(['status', '--porcelain', '--', ...CODE_PATHS]) ?? '';
  return {
    head,
    dirtyPaths: status
      .split('\n')
      .map((l) => l.slice(3).trim())
      .filter((l) => l.length > 0 && !l.startsWith('evals/results')),
  };
}

export function writeResult(suite: string, payload: SuitePayload): SuiteResult {
  if (!/^[a-z0-9-]+$/.test(suite)) throw new Error(`Bad suite name: ${suite}`);
  const ids = new Set<string>();
  for (const h of payload.headlines) {
    if (ids.has(h.id)) throw new Error(`Duplicate headline id ${h.id} in ${suite}`);
    ids.add(h.id);
    if (h.value.length > 40) throw new Error(`Headline value too long for ${h.id}: "${h.value}"`);
    if (h.baseline && h.baseline.length > 60) throw new Error(`Baseline too long for ${h.id}: "${h.baseline}"`);
  }
  const result: SuiteResult = {
    suite,
    title: payload.title,
    ranAt: new Date().toISOString(),
    gitSha: gitSha(),
    headlines: payload.headlines,
    ...(payload.limitations ? { limitations: payload.limitations } : {}),
    details: payload.details,
  };
  mkdirSync(RESULTS_DIR, { recursive: true });
  // Key order matches the documented shape.
  const ordered = {
    suite: result.suite,
    title: result.title,
    ranAt: result.ranAt,
    gitSha: result.gitSha,
    headlines: result.headlines,
    ...(result.limitations ? { limitations: result.limitations } : {}),
    details: result.details,
  };
  writeFileSync(path.join(RESULTS_DIR, `${suite}.json`), `${JSON.stringify(ordered, null, 2)}\n`);
  return result;
}

export function readResults(): SuiteResult[] {
  let files: string[] = [];
  try {
    files = readdirSync(RESULTS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  return files
    .sort()
    .map((f) => JSON.parse(readFileSync(path.join(RESULTS_DIR, f), 'utf8')) as SuiteResult)
    .filter((r) => typeof r.suite === 'string' && Array.isArray(r.headlines));
}

/** "3 of 60" */
export function ofN(k: number, n: number): string {
  return `${k} of ${n}`;
}
