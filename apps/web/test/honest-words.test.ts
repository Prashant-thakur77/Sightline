import { beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Verdict } from '@sightline/core';

/*
 * The words judges and the store read must match the records: suggestions only offer replies that
 * have a button and start from the store's own shipping record, and featured numbers say how they
 * were measured, from the result files.
 */
try {
  process.loadEnvFile(path.resolve(import.meta.dirname, '../../../.env.local'));
} catch {
  /* CI provides env directly */
}
const hasEnv = Boolean(process.env.DATABASE_URL);

const sizeVerdict = (confidence: 'sure' | 'fairly_sure'): Verdict =>
  ({
    kind: confidence === 'sure' ? 'mismatch' : 'unsure',
    headline: 'x',
    reasons: [{ module: 'size', finding: 'disagree', confidence, expected: 'M', observed: 'L', sentence: 'x' }],
  }) as unknown as Verdict;

describe.skipIf(!hasEnv)('suggested reply on the cases desk', () => {
  let m: typeof import('../src/server/merchant');
  beforeAll(async () => {
    m = await import('../src/server/merchant');
  });

  it('starts from what the store says it sent', () => {
    const s = m.suggestResponse(sizeVerdict('fairly_sure'), 'wrong_size', '$36.72', { refundPath: 'refund', dispute: false });
    expect(s.action).toBe('refund');
    expect(s.why).toContain('you sent the wrong size (L)');
  });

  it('asks for the item back when the record says the right item and the check is not sure', () => {
    const s = m.suggestResponse(sizeVerdict('fairly_sure'), 'correct', '$36.72', { refundPath: 'refund', dispute: false });
    expect(s.action).toBe('return');
    expect(s.why).toContain('you sent the right item');
  });

  it('never suggests a refund the store cannot send', () => {
    const s = m.suggestResponse(sizeVerdict('sure'), 'wrong_size', '$36.72', { refundPath: 'none', dispute: false });
    expect(s.action).toBe('replacement');
    expect(s.why).toContain('no PayPal payment');
  });

  it('always names a reply that has a button', () => {
    const verdicts = [null, sizeVerdict('sure'), sizeVerdict('fairly_sure'), { kind: 'match', headline: 'x', reasons: [] } as unknown as Verdict];
    for (const v of verdicts)
      for (const sent of [null, 'correct', 'wrong_size', 'nothing'])
        for (const refundPath of ['refund', 'void', 'none'] as const)
          for (const reason of ['wrong_size', 'not_received'])
            expect(m.CASE_ACTIONS).toContain(m.suggestResponse(v, sent, '$1.00', { reason, refundPath, dispute: false }).action);
  });
});

describe('featured results', () => {
  const file = async (suite: string) =>
    JSON.parse(await readFile(path.resolve(import.meta.dirname, `../../../evals/results/${suite}.json`), 'utf8')) as {
      headlines: { id: string; value: string; baseline?: string; negative?: boolean }[];
    };

  it('shows every pick, tags negative results and says how each was measured', async () => {
    const { featuredHeadlines } = await import('../src/server/headlines');
    const cards = await featuredHeadlines(6);
    const byId = new Map(cards.map((c) => [c.id, c]));
    expect([...byId.keys()]).toContain('barrier-keyboard-blocked-incl-dialogs');

    const sb = byId.get('mismatch-recall')!;
    const sbFile = await file('sightbench');
    expect(sb.negative).toBe(sbFile.headlines.find((h) => h.id === 'mismatch-recall')!.negative === true || undefined);
    const abstained = sbFile.headlines.find((h) => h.id === 'abstention')!.value.split(' (')[0]!;
    expect(sb.context).toContain(abstained);

    expect(byId.get('breaches-sightline')!.label).toContain('local ledger simulation');

    const dup = (await file('duplicates')).headlines.find((h) => h.id === 'duplicate-scenarios')!;
    // The baseline the suite declares on that headline, whatever words introduce it.
    expect(byId.get('duplicate-scenarios')!.baseline).toMatch(new RegExp(`: ${dup.baseline!.split(':').pop()!.trim()}$`));
    expect(dup.baseline).toMatch(/random request id/);
  });
});
