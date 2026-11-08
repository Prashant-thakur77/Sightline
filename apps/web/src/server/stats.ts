import 'server-only';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/** One headline number, exactly as an eval script wrote it. Nothing here is typed in by hand. */
export interface Headline {
  id: string;
  label: string;
  value: string;
  baseline?: string;
  interval?: string;
  n?: number;
  script: string;
  ranAt?: string;
  gitSha?: string;
  negative?: boolean;
  note?: string;
}

export interface SuiteResult {
  suite: string;
  title: string;
  ranAt: string;
  gitSha: string;
  headlines: Headline[];
  limitations?: string[];
}

function resultsDir(): string {
  // apps/web runs with cwd = apps/web in dev and in the standalone build.
  const candidates = [path.resolve(process.cwd(), '../../evals/results'), path.resolve(process.cwd(), 'evals/results')];
  return candidates[0]!;
}

export async function loadSuites(): Promise<SuiteResult[]> {
  const dir = resultsDir();
  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: SuiteResult[] = [];
  for (const f of files.sort()) {
    try {
      const j = JSON.parse(await readFile(path.join(dir, f), 'utf8')) as SuiteResult;
      if (j.suite && Array.isArray(j.headlines)) out.push(j);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}
