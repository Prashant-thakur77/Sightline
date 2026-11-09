/**
 * Runs every suite in its own process, then regenerates RESULTS.md. Stops at the first failing
 * suite and leaves RESULTS.md untouched, so a failure is never hidden behind older numbers.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { EVALS_DIR } from './lib/results';

const SUITES = ['confirmation/run.ts', 'redteam/run.ts', 'duplicates/run.ts', 'grounding/run.ts', 'store-agent/run.ts'];
const tsx = path.join(EVALS_DIR, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');

function run(file: string): void {
  const started = Date.now();
  const r = spawnSync(tsx, [path.join(EVALS_DIR, file)], { cwd: EVALS_DIR, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`evals: ${file} failed (exit ${r.status ?? r.signal}). RESULTS.md was not regenerated.`);
    process.exit(r.status ?? 1);
  }
  console.log(`evals: ${file} done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

for (const s of SUITES) run(s);
run('report.ts');
