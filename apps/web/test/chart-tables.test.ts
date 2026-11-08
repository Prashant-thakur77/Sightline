import { describe, expect, it } from 'vitest';
import { barrierChartTables } from '@/components/studio/barrier-report';
import type { BarrierData, StudioCheckRow, StudioOrderRow, VerifiedDeliveryData } from '@/components/studio/types';
import { verifiedDeliveryChartTables } from '@/components/studio/verified-delivery-report';

/* The tables under each dashboard carry the same numbers the charts draw (WCAG 1.1.1). */

const order = (id: string, moneyState: StudioOrderRow['moneyState'], amountCents: number) => ({ id, moneyState, amountCents }) as StudioOrderRow;
const check = (id: string, mismatchType: string, verdict: StudioCheckRow['verdict']) => ({ id, mismatchType, verdict }) as StudioCheckRow;

describe('verifiedDeliveryChartTables', () => {
  const data = {
    orders: [order('a', 'Captured', 3672), order('b', 'Held', 3672), order('c', 'Captured', 2999), order('d', 'Voided', 4100)],
    checks: [check('1', 'No mismatch', 'Match'), check('2', 'Wrong size', 'Mismatch'), check('3', 'No mismatch', 'Match'), check('4', 'Unclear: colour', 'Not sure')],
  } as VerifiedDeliveryData;
  const [verdicts, money] = verifiedDeliveryChartTables(data);

  it('counts checks by mismatch type and verdict, largest first', () => {
    expect(verdicts!.title).toBe('Verdicts by mismatch type');
    expect(verdicts!.columns).toEqual(['Mismatch type', 'Verdict', 'Checks']);
    expect(verdicts!.rows.map((r) => r.cells)).toEqual([
      ['No mismatch', 'Match', '2'],
      ['Unclear: colour', 'Not sure', '1'],
      ['Wrong size', 'Mismatch', '1'],
    ]);
  });

  it('sums order value by payment state in dollars, largest first', () => {
    expect(money!.title).toBe('Where the money is');
    expect(money!.rows.map((r) => r.cells)).toEqual([
      ['Captured', '$66.71'],
      ['Voided', '$41.00'],
      ['Held', '$36.72'],
    ]);
  });

  it('has no rows, and says so, before anything happens', () => {
    const empty = verifiedDeliveryChartTables({ orders: [], checks: [] } as unknown as VerifiedDeliveryData);
    expect(empty.map((t) => t.rows.length)).toEqual([0, 0]);
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
});
