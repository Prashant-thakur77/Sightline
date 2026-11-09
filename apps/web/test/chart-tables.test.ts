import { describe, expect, it } from 'vitest';
import { barrierChartTables } from '@/components/studio/barrier-report';
import type { BarrierData, StudioCheckRow, StudioOrderRow, VerifiedDeliveryData } from '@/components/studio/types';
import { verifiedDeliveryChartTables } from '@/components/studio/verified-delivery-report';

/* The tables under each dashboard carry the same numbers the charts draw (WCAG 1.1.1). */

const order = (id: string, moneyState: StudioOrderRow['moneyState'], amountCents: number) => ({ id, moneyState, amountCents }) as StudioOrderRow;
const check = (id: string, mismatchType: string, verdict: StudioCheckRow['verdict']) => ({ id, mismatchType, verdict }) as StudioCheckRow;

describe('verifiedDeliveryChartTables', () => {
  const data = {
    orders: [order('a', 'Paid', 3672), order('b', 'On hold', 3672), order('c', 'Paid', 2999), order('d', 'Hold released', 4100)],
    checks: [check('1', 'No mismatch', 'Match'), check('2', 'Wrong size', 'Mismatch'), check('3', 'No mismatch', 'Match'), check('4', 'Could not check colour', 'Not sure')],
    cases: [],
  } as unknown as VerifiedDeliveryData;
  const [verdicts, money] = verifiedDeliveryChartTables(data);

  it('counts checks by mismatch type and verdict, largest first', () => {
    expect(verdicts!.title).toBe('Verdicts by mismatch type');
    expect(verdicts!.columns).toEqual(['Mismatch type', 'Verdict', 'Checks']);
    expect(verdicts!.rows.map((r) => r.cells)).toEqual([
      ['No mismatch', 'Match', '2'],
      ['Could not check colour', 'Not sure', '1'],
      ['Wrong size', 'Mismatch', '1'],
    ]);
  });

  it('sums order value by payment state in dollars, largest first', () => {
    expect(money!.title).toBe('Where the money is');
    expect(money!.rows.map((r) => r.cells)).toEqual([
      ['Paid', '$66.71'],
      ['Hold released', '$41.00'],
      ['On hold', '$36.72'],
    ]);
  });

  it('has no rows, and says so, before anything happens', () => {
    const empty = verifiedDeliveryChartTables({ orders: [], checks: [], cases: [] } as unknown as VerifiedDeliveryData);
    expect(empty.map((t) => t.rows.length)).toEqual([0, 0, 0, 0]);
    expect(empty.every((t) => t.empty.length > 0)).toBe(true);
  });
});

describe('barrierChartTables', () => {
  const store = (platform: string, productViolations: number | null, homeViolations: number | null, keyboardOutcome: string) =>
    ({ platform, productViolations, homeViolations, keyboardOutcome }) as BarrierData['stores'][number];
  const data = {
    stores: [store('Shopify', 4, 4, 'Reached'), store('Shopify', 5, 2, 'Reached'), store('Custom', null, null, 'Not tested'), store('Shopify', 8, 7, 'Needs a size first')],
    rules: [
      { id: 'label', help: '', storesAffected: 2, totalNodes: 3 },
      { id: 'button-name', help: '', storesAffected: 4, totalNodes: 9 },
    ],
  } as BarrierData;
  const [platforms, keyboard, rules] = barrierChartTables(data);

  it('takes the median per platform, ignoring stores that were not audited', () => {
    expect(platforms!.rows.map((r) => r.cells)).toEqual([
      ['Shopify', '5', '4'],
      ['Custom', 'Not audited', 'Not audited'],
    ]);
  });

  it('counts stores by keyboard outcome and lists rules by stores failing, largest first', () => {
    expect(keyboard!.rows.map((r) => r.cells)).toEqual([
      ['Reached', '2'],
      ['Needs a size first', '1'],
      ['Not tested', '1'],
    ]);
    expect(rules!.rows.map((r) => r.cells)).toEqual([
      ['button-name', '4'],
      ['label', '2'],
    ]);
  });

  it('also writes out the grids: every rule with its failing elements, and every audited store', () => {
    const [, , , detail, stores] = barrierChartTables(data);
    expect(detail!.title).toBe('What each rule checks');
    expect(detail!.rows.map((r) => [r.cells[0], r.cells[2], r.cells[3]])).toEqual([
      ['button-name', '4', '9'],
      ['label', '2', '3'],
    ]);
    expect(stores!.title).toBe('Stores');
    expect(stores!.rows).toHaveLength(3);
  });
});

describe('verifiedDeliveryChartTables grids', () => {
  it('writes out recent checks and cases, newest first', () => {
    const data = {
      orders: [],
      checks: [
        { id: '1', orderRef: 'AAA', item: 'Sweater', verdictLabel: '✕ Mismatch', mismatchType: 'Wrong size', checkedAt: '2026-11-08T10:00:00Z', latencyMs: 1100 },
        { id: '2', orderRef: 'BBB', item: 'Mug', verdictLabel: '? Not sure', mismatchType: 'Could not check colour', checkedAt: '2026-11-09T10:00:00Z', latencyMs: null },
      ],
      cases: [{ id: 'c', ref: 'CCC', stage: 'Waiting for the store', reason: 'Wrong size', outcome: '', openedAt: '2026-11-09T11:00:00Z', resolvedAt: null }],
    } as unknown as VerifiedDeliveryData;
    const [, , checks, cases] = verifiedDeliveryChartTables(data);
    expect(checks!.rows.map((r) => r.cells[1])).toEqual(['BBB', 'AAA']);
    expect(checks!.rows[1]!.cells[5]).toBe('1.1 s');
    expect(cases!.rows[0]!.cells).toEqual(['CCC', 'Waiting for the store', 'Wrong size', '—', '2026-11-09 11:00 UTC', 'Not yet']);
  });
});
