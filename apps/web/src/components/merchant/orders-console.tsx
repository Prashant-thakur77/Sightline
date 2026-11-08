'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useAnnouncer } from '@/components/a11y/announcer';
import type { MerchantOrderRow, MerchantResult, ShipChoice } from '@/server/merchant';
import type { OrdersGrid as OrdersGridType } from './orders-grid';
import { OrdersTable, ShipmentStatus, variantText } from './orders-table';
import { StatusChip } from './status-chip';

const SHIP_BUTTONS: { variant: ShipChoice; label: string }[] = [
  { variant: 'correct', label: 'Ship the right item' },
  { variant: 'wrong_colour', label: 'Ship the wrong colour (black)' },
  { variant: 'wrong_size', label: 'Ship the wrong size (L)' },
  { variant: 'damaged', label: 'Ship it damaged' },
  { variant: 'nothing', label: "Don't ship" },
];

/** The interactive grid is worth its weight only on wide screens; narrow screens keep the table. */
const GRID_QUERY = '(min-width: 900px)';

/**
 * Loads the grid module only when the viewport is wide enough, after the server-rendered table is
 * on screen. Returns null (keep the table) until then, and again if the viewport narrows.
 */
function useWideGrid(): typeof OrdersGridType | null {
  const [grid, setGrid] = useState<typeof OrdersGridType | null>(null);
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(GRID_QUERY);
    let live = true;
    const update = () => {
      setWide(mq.matches);
      if (mq.matches)
        import('./orders-grid')
          .then((m) => live && setGrid(() => m.OrdersGrid))
          .catch(() => {
            /* The table stays. It does everything the grid does. */
          });
    };
    update();
    mq.addEventListener('change', update);
    return () => {
      live = false;
      mq.removeEventListener('change', update);
    };
  }, []);
  return wide ? grid : null;
}

/**
 * A demo control. When it is shown but cannot run, it stays focusable (aria-disabled, not
 * disabled) and its description says why.
 */
function DemoButton({
  label,
  working,
  unavailable,
  describedBy,
  className = 'btn mx-btn',
  onRun,
}: {
  label: string;
  working: boolean;
  unavailable: boolean;
  describedBy?: string;
  className?: string;
  onRun: () => void;
}) {
  return (
    <button
      type="button"
      className={className}
      aria-disabled={unavailable || undefined}
      aria-describedby={describedBy}
      onClick={() => {
        if (!unavailable) onRun();
      }}
    >
      {working ? 'Working…' : label}
    </button>
  );
}

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
  const ids = {
    heading: `${uid}-h`,
    order: `${uid}-order`,
    note: `${uid}-note`,
    pick: `${uid}-pick`,
    deliverWhy: `${uid}-deliver-why`,
  };
  const Grid = useWideGrid();
  // The table stays until the grid has drawn and measured its rows, then the grid replaces it.
  // If someone is already using the table by then, the table simply stays: it does the same job.
  const [gridReady, setGridReady] = useState(false);
  const [keepTable, setKeepTable] = useState(false);
  const tableRef = useRef<HTMLDivElement>(null);
  const showGrid = Boolean(Grid) && gridReady && !keepTable;
  const onGridReady = useCallback(() => {
    if (tableRef.current?.contains(document.activeElement)) setKeepTable(true);
    else setGridReady(true);
  }, []);
  useEffect(() => {
    if (!Grid) setGridReady(false);
  }, [Grid]);
  const selected = useMemo(
    () => rows.find((r) => r.id === selectedId) ?? rows[0] ?? null,
    [rows, selectedId],
  );

  useEffect(() => {
    if (outcome) resultRef.current?.focus();
  }, [outcome]);

  // Which order the panel shows when a run finishes: its result is focused only if it is still shown.
  const shownId = useRef<string | null>(null);
  useEffect(() => {
    shownId.current = selected?.id ?? null;
  });

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
    if (!selected || busy) return;
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
      // Focus moves to the result, which says the same thing: no live announcement on top of it.
      announce(message, { politeness: ok ? 'polite' : 'assertive', source: 'Demo Store', live: shownId.current !== orderId });
      router.refresh();
    } catch {
      const message = 'The console could not reach the server. Nothing changed. Try again.';
      setOutcome({ ok: false, message, orderId });
      announce(message, { politeness: 'assertive', source: 'Demo Store', live: shownId.current !== orderId });
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

  const tracking = selected.shipment.trackingNumber;
  const shownOutcome = outcome && outcome.orderId === selected.id ? outcome : null;
  const can = selected.can;
  const noAction = !can.ship && !can.deliver && !can.sendTracking;
  const nextUp = noAction ? rows.find((r) => r.can.ship || r.can.deliver) : undefined;
  const waiting = busy !== null;

  return (
    <div className="mx-orders">
      <section aria-labelledby={`${uid}-grid-h`} className="mx-grid-section">
        <div className="mx-section-head">
          <h2 id={`${uid}-grid-h`} className="mx-h2">
            All orders
          </h2>
          <p className="mx-hint">
            {showGrid
              ? 'Arrow keys move between cells. Enter or Space selects an order. Tab leaves the table.'
              : 'Choose an order number to open it in the Selected order panel.'}
          </p>
        </div>
        <div className="mx-orders-view">
          {Grid && !keepTable && (
            <div className="mx-grid-slot" data-pending={!gridReady || undefined}>
              <Grid
                rows={rows}
                labelledBy={`${uid}-grid-h`}
                selectedId={selected.id}
                onSelect={select}
                onReady={onGridReady}
              />
            </div>
          )}
          {!showGrid && (
            <div ref={tableRef}>
              <OrdersTable
                rows={rows}
                labelledBy={`${uid}-grid-h`}
                selectedId={selected.id}
                onSelect={select}
              />
            </div>
          )}
        </div>
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
            <p id={ids.order} className="eyebrow">
              Selected order #{selected.ref}
            </p>
            <h2 id={ids.heading} className="mx-panel-h">
              {selected.buyer}&rsquo;s {selected.item}
            </h2>
            <dl className="mx-facts">
              <div>
                <dt>Colour and size</dt>
                <dd>{variantText(selected) || 'Not listed'}</dd>
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
                  {selected.payment.detail && <span className="mx-sub">{selected.payment.detail}</span>}
                </dd>
              </div>
              <div>
                <dt>Shipment</dt>
                <dd>
                  <ShipmentStatus s={selected.shipment} />
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
            {selected.verdict.summary && (
              <p className="mx-verdict-line">Buyer&rsquo;s check: {selected.verdict.summary}</p>
            )}
          </div>

          {noAction ? (
            <details className="mx-demo mx-demo-off">
              <summary>
                <span className="mx-demo-tag">Demo controls</span>
                <span className="mx-demo-why">{selected.blocked}</span>
              </summary>
              <div className="mx-demo-off-body">
                <p className="mx-demo-note">
                  Demo controls simulate the warehouse and the carrier: ship the right item, a wrong one, a
                  damaged one or nothing, then mark it delivered. Nothing more can be simulated for order #
                  {selected.ref}.
                </p>
                {nextUp && (
                  <button type="button" className="btn mx-btn" onClick={() => select(nextUp.id)}>
                    Open order #{nextUp.ref}, {nextUp.can.ship ? 'ready to ship' : 'on its way'}
                  </button>
                )}
              </div>
            </details>
          ) : (
            <fieldset className="mx-demo" aria-describedby={ids.note}>
              <legend>
                <span className="mx-demo-tag">Demo controls</span>
              </legend>
              <p id={ids.note} className="mx-demo-note">
                These simulate the warehouse and the carrier for order #{selected.ref}.
              </p>
              {can.ship ? (
                <div className="mx-demo-ship">
                  {SHIP_BUTTONS.map((b) => (
                    <DemoButton
                      key={b.variant}
                      label={b.label}
                      working={busy === b.variant}
                      unavailable={waiting}
                      describedBy={ids.order}
                      onRun={() =>
                        run(b.variant, `/api/merchant/orders/${selected.id}/ship`, { variant: b.variant })
                      }
                    />
                  ))}
                </div>
              ) : (
                <p className="mx-demo-line">{selected.why.ship}</p>
              )}
              {(can.deliver || can.ship || can.sendTracking) && (
                <div className="mx-demo-deliver">
                  {can.deliver ? (
                    <DemoButton
                      className="btn btn-primary mx-btn-xl"
                      label="Mark as delivered"
                      working={busy === 'deliver'}
                      unavailable={waiting}
                      describedBy={ids.order}
                      onRun={() => run('deliver', `/api/merchant/orders/${selected.id}/deliver`)}
                    />
                  ) : (
                    can.ship && (
                      <>
                        <DemoButton
                          label="Mark as delivered"
                          working={false}
                          unavailable
                          describedBy={ids.deliverWhy}
                          onRun={() => undefined}
                        />
                        <p id={ids.deliverWhy} className="mx-demo-note">
                          {selected.why.deliver}
                        </p>
                      </>
                    )
                  )}
                  {can.sendTracking && (
                    <DemoButton
                      label="Send tracking to PayPal"
                      working={busy === 'tracking'}
                      unavailable={waiting}
                      describedBy={ids.order}
                      onRun={() => run('tracking', `/api/merchant/orders/${selected.id}/tracking`)}
                    />
                  )}
                </div>
              )}
              {!paypalReady && (
                <p className="mx-demo-note">
                  PayPal sandbox keys are not set on this server, so tracking stays here and is not sent to
                  PayPal.
                </p>
              )}
            </fieldset>
          )}
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
