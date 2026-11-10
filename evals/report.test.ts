import { describe, expect, it } from 'vitest';
import type { SuiteResult } from './lib/results';
import { renderReadmeNumbers, renderReport } from './report';

const suite = (name: string, value = '0 of 60'): SuiteResult => ({
  suite: name,
  title: name,
  ranAt: '2026-11-10T00:00:00.000Z',
  gitSha: 'abc1234',
  headlines: [{ id: 'h', label: `${name} headline`, value, script: `evals/${name}.ts` }],
  details: {},
});

describe('report wording about the PayPal sandbox ledger', () => {
  it('says no suite ran against the sandbox ledger when none did', () => {
    const r = [suite('redteam'), suite('agent-live')];
    expect(renderReport(r)).toContain('No suite here ran against the PayPal sandbox ledger.');
    expect(renderReadmeNumbers(r)).toContain('none of these numbers comes from the PayPal sandbox ledger');
  });

  it('names the sandbox-ledger suites once they exist, and labels their README rows', () => {
    const r = [suite('redteam'), suite('redteam-sandbox'), suite('duplicates-sandbox'), suite('agent-live')];
    const report = renderReport(r);
    expect(report).not.toContain('No suite here ran against the PayPal sandbox ledger');
    expect(report).toContain('`redteam-sandbox` and `duplicates-sandbox` ran against the PayPal sandbox ledger');
    expect(report).toContain('Only `agent-live` called a live model');
    const readme = renderReadmeNumbers(r);
    expect(readme).not.toContain('none of these numbers comes from the PayPal sandbox ledger');
    expect(readme).toMatch(/\| redteam-sandbox headline \| 0 of 60 \| — \| sandbox ledger[^|]*`redteam-sandbox` \|/);
    expect(readme).toMatch(/\| redteam headline \| 0 of 60 \| — \| simulated, offline · `redteam` \|/);
  });
});
