'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ColDef } from 'ag-grid-community';
import { useAnnouncer } from '@/components/a11y/announcer';
import type { MerchantOrderRow, MerchantResult, ShipChoice } from '@/server/merchant';
import { DataGrid, StatusChip, statusColumn } from './grid';

const SHIP_BUTTONS: { variant: ShipChoice; label: string }[] = [
  { variant: 'correct', label: 'Ship the right item' },
  { variant: 'wrong_colour', label: 'Ship the wrong colour (black)' },
  { variant: 'wrong_size', label: 'Ship the wrong size (L)' },
  { variant: 'damaged', label: 'Ship it damaged' },
  { variant: 'nothing', label: "Don't ship" },
];

const COLUMNS: ColDef<MerchantOrderRow>[] = [
  {
    headerName: 'Order',
    field: 'ref',
    valueFormatter: (p) => `#${p.value}`,
    cellClass: 'mx-mono',
    width: 112,
    minWidth: 112,
  },
  { headerName: 'Buyer', field: 'buyer', width: 92, minWidth: 88 },
  { headerName: 'Item', field: 'item', flex: 1.3, minWidth: 160 },
  {
    headerName: 'Colour, size',
    colId: 'variant',
    valueGetter: (p) => [p.data?.colour, p.data?.size && `size ${p.data.size}`].filter(Boolean).join(', '),
    width: 112,
    minWidth: 104,
  },
  {
    headerName: 'Amount',
    field: 'amountCents',
    valueFormatter: (p) => p.data?.amount ?? '',
    cellClass: 'mx-num',
    headerClass: 'mx-num-h',
    width: 100,
    minWidth: 96,
  },
  statusColumn<MerchantOrderRow>({ headerName: 'PayPal', field: 'payment', flex: 1, minWidth: 150 }),
  statusColumn<MerchantOrderRow>({ headerName: 'Shipment', field: 'shipment', flex: 1.1, minWidth: 160 }),
  statusColumn<MerchantOrderRow>({ headerName: 'Check', field: 'verdict', width: 148, minWidth: 140 }),
  statusColumn<MerchantOrderRow>({ headerName: 'Case', field: 'case', flex: 1, minWidth: 150 }),
];

interface Outcome {
  ok: boolean;
  message: string;
  orderId: string;
}

export function OrdersConsole({ rows, paypalReady }: { rows: MerchantOrderRow[]; paypalReady: boolean }) {
  const router = useRouter();
  const { announce } = useAnnouncer();
  const [selectedId, setSelectedId] = useState<string | null>(
    () => (rows.find((r) => r.can.ship || r.can.deliver) ?? rows[0])?.id ?? null,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const resultRef = useRef<HTMLParagraphElement>(null);
  const uid = useId();
  const ids = { heading: `${uid}-h`, note: `${uid}-note`, pick: `${uid}-pick` };
  const selected = useMemo(
    () => rows.find((r) => r.id === selectedId) ?? rows[0] ?? null,
    [rows, selectedId],
  );

  useEffect(() => {
    if (outcome) resultRef.current?.focus();
  }, [outcome]);

  const select = useCallback(
    (id: string) => {
      const row = rows.find((r) => r.id === id);
      if (!row) return;
      setSelectedId(id);
      setOutcome(null);
      announce(
        `Selected order ${row.ref}: ${row.buyer}, ${row.item}. ${row.shipment.word}. Demo controls are in the Selected order panel.`,
        { source: 'Demo Store' },
      );
    },
    [rows, announce],
  );

  const run = async (key: string, url: string, body?: unknown) => {
    if (!selected) return;
    setBusy(key);
    const orderId = selected.id;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      const data = (await res.json().catch(() => null)) as MerchantResult | null;
      const message = data?.message ?? 'Something went wrong. Nothing changed.';
      const ok = res.ok && Boolean(data?.ok);
      setOutcome({ ok, message, orderId });
      announce(message, { politeness: ok ? 'polite' : 'assertive', source: 'Demo Store' });
      router.refresh();
    } catch {
      const message = 'The console could not reach the server. Nothing changed. Try again.';
      setOutcome({ ok: false, message, orderId });
      announce(message, { politeness: 'assertive', source: 'Demo Store' });
    } finally {
      setBusy(null);
    }
  };

  if (!selected) {
    return (
      <div className="mx-empty">
        <p className="mx-empty-h">No orders yet.</p>
        <p>When a buyer pays Demo Store with PayPal, the order appears here, newest first.</p>
      </div>
    );
  }

  const order = <span className="sr-only"> for order {selected.ref}</span>;
  const tracking = selected.shipment.trackingNumber;
  const shownOutcome = outcome && outcome.orderId === selected.id ? outcome : null;

  return (
    <div className="mx-orders">
      <section aria-labelledby={`${uid}-grid-h`} className="mx-grid-section">
        <div className="mx-section-head">
          <h2 id={`${uid}-grid-h`} className="mx-h2">
            All orders
          </h2>
          <p className="mx-hint">
            Arrow keys move between cells. Enter or Space selects an order. Tab leaves the table.
          </p>
        </div>
        <DataGrid
          rows={rows}
          columns={COLUMNS}
          labelledBy={`${uid}-grid-h`}
          selectedId={selected.id}
          onSelect={select}
          autoHeight
        />
      </section>

      <section aria-labelledby={ids.heading} className="mx-panel">
        <div className="mx-panel-pick">
          <label htmlFor={ids.pick} className="mx-label">
            Choose an order
          </label>
          <select id={ids.pick} value={selected.id} onChange={(e) => select(e.target.value)}>
            {rows.map((r) => (
              <option key={r.id} value={r.id}>
                #{r.ref} · {r.buyer} · {r.item}
              </option>
            ))}
          </select>
        </div>

        <div className="mx-panel-body">
          <div className="mx-panel-facts">
            <p className="eyebrow">Selected order #{selected.ref}</p>
            <h2 id={ids.heading} className="mx-panel-h">
              {selected.buyer}&rsquo;s {selected.item}
            </h2>
            <dl className="mx-facts">
              <div>
                <dt>Colour and size</dt>
                <dd>
                  {[selected.colour, selected.size && `size ${selected.size}`].filter(Boolean).join(', ') ||
                    'Not listed'}
                </dd>
              </div>
              <div>
                <dt>Amount</dt>
                <dd>
                  {selected.amount}
                  <span className="mx-sub">
                    {selected.intent === 'AUTHORIZE' ? 'Pay after check' : 'Paid at checkout'}
                  </span>
                </dd>
              </div>
              <div>
                <dt>PayPal</dt>
                <dd>
                  <StatusChip s={selected.payment} />
                </dd>
              </div>
              <div>
                <dt>Shipment</dt>
                <dd>
                  <StatusChip s={selected.shipment} />
                </dd>
              </div>
              <div>
                <dt>Buyer&rsquo;s check</dt>
                <dd>
                  <StatusChip s={selected.verdict} />
                </dd>
              </div>
              <div>
                <dt>Case</dt>
                <dd>
                  <StatusChip s={selected.case} />
                  {selected.case.id && (
                    <Link className="mx-inline-link" href={`/merchant/disputes#case-${selected.case.id}`}>
                      Open the case<span className="sr-only"> for order {selected.ref}</span>
                    </Link>
                  )}
                </dd>
              </div>
            </dl>
            {tracking && (
              <p className="mx-tracking">
                {selected.shipment.carrier} tracking <span className="mono">{tracking}</span>
                {selected.shipment.trackerId
                  ? ' · on the PayPal order'
                  : selected.awaitingCapture
                    ? ' · goes to PayPal after the capture'
                    : ' · recorded here only'}
              </p>
            )}
            {selected.verdict.headline && (
              <p className="mx-verdict-line">Buyer&rsquo;s check: {selected.verdict.headline}</p>
            )}
          </div>

          <fieldset className="mx-demo" aria-describedby={ids.note}>
            <legend>
              <span className="mx-demo-tag">Demo controls</span>
            </legend>
            <p id={ids.note} className="mx-demo-note">
              These simulate the warehouse and the carrier for order #{selected.ref}.
              {selected.blocked ? ` ${selected.blocked}` : ''}
            </p>
            <div className="mx-demo-ship">
              {SHIP_BUTTONS.map((b) => (
                <button
                  key={b.variant}
                  type="button"
                  className="btn mx-btn"
                  data-variant={b.variant}
                  disabled={!selected.can.ship || busy !== null}
                  aria-describedby={ids.heading}
                  onClick={() =>
                    run(b.variant, `/api/merchant/orders/${selected.id}/ship`, { variant: b.variant })
                  }
                >
                  {busy === b.variant ? 'Working…' : b.label}
                  {order}
                </button>
              ))}
            </div>
            <div className="mx-demo-deliver">
              <button
                type="button"
                className="btn btn-primary mx-btn-xl"
                disabled={!selected.can.deliver || busy !== null}
                aria-describedby={ids.heading}
                onClick={() => run('deliver', `/api/merchant/orders/${selected.id}/deliver`)}
              >
                {busy === 'deliver' ? 'Working…' : 'Mark as delivered'}
                {order}
              </button>
              {selected.can.sendTracking && (
                <button
                  type="button"
                  className="btn mx-btn"
                  disabled={busy !== null}
                  aria-describedby={ids.heading}
                  onClick={() => run('tracking', `/api/merchant/orders/${selected.id}/tracking`)}
                >
                  {busy === 'tracking' ? 'Working…' : 'Send tracking to PayPal'}
                  {order}
                </button>
              )}
            </div>
            {!paypalReady && (
              <p className="mx-demo-note">
                PayPal sandbox keys are not set on this server, so tracking stays here and is not sent to
                PayPal.
              </p>
            )}
          </fieldset>
        </div>

        {shownOutcome && (
          <p ref={resultRef} tabIndex={-1} className="mx-result" data-ok={String(shownOutcome.ok)}>
            <span className="mx-glyph" aria-hidden="true">
              {shownOutcome.ok ? '✓' : '✕'}
            </span>
            <span>{shownOutcome.message}</span>
          </p>
        )}
      </section>
    </div>
  );
}
