'use client';

import { useId } from 'react';
import { useScrollsSideways } from '@/components/a11y/scroll-region';
import type { MerchantOrderRow } from '@/server/merchant';
import { StatusChip } from './status-chip';

/** "navy, size M": sizes keep their case. */
export function variantText(r: Pick<MerchantOrderRow, 'colour' | 'size'>): string {
  return [r.colour, r.size && `size ${r.size}`].filter(Boolean).join(', ');
}

/** The shipment status, plus the demo choice when a wrong or damaged item was sent ("!", never "✓"). */
export function ShipmentStatus({ s }: { s: MerchantOrderRow['shipment'] }) {
  return (
    <span className="mx-stack">
      <StatusChip s={s} />
      {s.sent && s.sent.tone === 'bad' && <StatusChip s={s.sent} />}
    </span>
  );
}

/**
 * The orders as a plain table. Rendered on the server, so it works before any script loads, and
 * kept on narrow screens, where each row becomes a card. Each order number is a button that opens
 * the order in the Selected order panel.
 */
export function OrdersTable({
  rows,
  labelledBy,
  selectedId,
  onSelect,
}: {
  rows: MerchantOrderRow[];
  labelledBy: string;
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const label = (text: string) => <span className="mx-t-label">{text}</span>;
  const hintId = useId();
  const [wrapRef, scrolls] = useScrollsSideways();
  // Only a table that scrolls sideways is a region in the Tab order, named apart from the section
  // around it ("All orders table, scrolls sideways"). On a phone each row is a card and nothing
  // scrolls, so there is no extra landmark and no extra Tab stop.
  const region = scrolls
    ? ({ role: 'region', tabIndex: 0, 'aria-labelledby': `${labelledBy} ${hintId}` } as const)
    : {};
  return (
    <div ref={wrapRef} className="mx-table-wrap" {...region}>
      <span id={hintId} hidden>
        table, scrolls sideways
      </span>
      <table className="mx-table" aria-labelledby={labelledBy}>
        <thead>
          <tr>
            <th scope="col">Order</th>
            <th scope="col">Buyer</th>
            <th scope="col">Item</th>
            <th scope="col">Colour, size</th>
            <th scope="col" className="mx-num">
              Amount
            </th>
            <th scope="col">PayPal</th>
            <th scope="col">Shipment</th>
            <th scope="col">Check</th>
            <th scope="col">Case</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const selected = r.id === selectedId;
            return (
              <tr key={r.id} data-selected={selected || undefined}>
                <th scope="row">
                  <button
                    type="button"
                    className="mx-pick"
                    aria-pressed={selected}
                    onClick={() => onSelect(r.id)}
                  >
                    <span className="sr-only">Order </span>#{r.ref}
                  </button>
                </th>
                <td>
                  {label('Buyer')}
                  {r.buyer}
                </td>
                <td className="mx-t-item">
                  {label('Item')}
                  {r.item}
                </td>
                <td>
                  {label('Colour, size')}
                  {variantText(r) || 'Not listed'}
                </td>
                <td className="mx-num">
                  {label('Amount')}
                  {r.amount}
                </td>
                <td>
                  {label('PayPal')}
                  <StatusChip s={r.payment} />
                </td>
                <td>
                  {label('Shipment')}
                  <ShipmentStatus s={r.shipment} />
                </td>
                <td>
                  {label('Check')}
                  <StatusChip s={r.verdict} />
                </td>
                <td>
                  {label('Case')}
                  <StatusChip s={r.case} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
