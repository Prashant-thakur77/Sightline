import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { desc, eq } from 'drizzle-orm';
import { tables } from '@sightline/db';
import {
  CONFIDENCE_WORD,
  FINDING,
  MODULE_LABEL,
  caseStatus,
  formatMoney,
  paymentStatus,
  shipmentStatus,
  spokenDate,
  verdictStatus,
  type StatusWord,
} from '@sightline/core';
import { currentUser, requireUser } from '@/server/session';
import { orderForUser } from '@/server/orders-read';
import { db } from '@/server/runtime';
import { MoneyBack } from '@/components/orders/money-back';
import { AskHelper } from '@/components/orders/ask-helper';
import { FocusFromHash } from '@/components/orders/focus-from-hash';

export const dynamic = 'force-dynamic';

/** One read per request: the title and the page share it. */
const loadOrder = cache(orderForUser);

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const user = await currentUser();
  // Without a session the layout sends the person to /start, so this title is never seen.
  if (!user) return { title: 'Order' };
  const found = await loadOrder(id, user.id);
  if (!found?.snapshot) notFound();
  return { title: `${found.snapshot.title}, order` };
}

function Section({ n, id, tab, state, children }: { n: number; id: string; tab: string; state: StatusWord; children: React.ReactNode }) {
  return (
    <li id={id} className="folder case-folder" data-tone={state.tone} style={{ ['--k' as string]: n - 1 }}>
      <h2 className="folder-tab">
        <span className="case-glyph" aria-hidden="true">
          {state.glyph}
        </span>{' '}
        {tab}
        <span className="sr-only">, {state.word}</span>
      </h2>
      <div className="folder-body case-body">{children}</div>
    </li>
  );
}

/** Times on this page are UTC and say so, so they never disagree with what was said aloud. */
const when = (iso: string) => `${new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC`;

/** Each audit action as a plain sentence; unknown ones fall back to their words. */
const HAPPENED: Record<string, string> = {
  'readback.spoken': 'I read the order back to you',
  'readback.confirmed': 'You confirmed the purchase',
  'gate.allowed': 'The payment check passed',
  'gate.refused': 'The payment check stopped the payment',
  'order.created': 'The order went to PayPal',
  'order.outcome_unknown': 'PayPal had not answered yet',
  'shipment.shipped': 'Demo Store shipped it',
  'shipment.not_shipped': 'Demo Store marked it as not shipped',
  'shipment.delivered': 'It was delivered',
  'tracking.sent': 'Tracking was added to the PayPal order',
  'check.photos_sent': 'You sent photos for the check',
  'check.verdict': 'The camera check finished',
  'payment.captured_after_check': 'PayPal paid Demo Store after the check matched',
  'payment.voided_after_check': 'PayPal cancelled the payment hold',
  'evidence.built': 'The evidence pack was signed',
  'case.sent_to_seller': 'Your case went to Demo Store',
  'case.offer_made': 'Demo Store made an offer',
  'case.no_response': 'Demo Store did not reply in time',
  'helper.asked': 'You asked your helper to look',
  'helper.answered': 'Your helper answered',
  'helper.revoked': 'You cancelled the helper link',
  refund: 'Demo Store refunded the payment',
};
function happened(action: string): string {
  if (HAPPENED[action]) return HAPPENED[action]!;
  if (action.startsWith('webhook.')) return 'PayPal sent an update';
  const words = action.replace(/[._]/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function Technical({ step, rows }: { step: string; rows: [string, string | null | undefined][] }) {
  const shown = rows.filter((r): r is [string, string] => Boolean(r[1]));
  if (!shown.length) return null;
  return (
    <details className="tech">
      <summary>Technical details: {step}</summary>
      <dl className="hashes">
        {shown.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd className="mono">{v}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const found = await loadOrder(id, user.id);
  if (!found || !found.snapshot) notFound();
  const { order: o, snapshot: s, shipment, verification, kase } = found;
  const [rb] = await db().select().from(tables.readbacks).where(eq(tables.readbacks.id, o.readbackId)).limit(1);
  const [pack] = kase?.evidencePackId
    ? await db().select().from(tables.evidencePacks).where(eq(tables.evidencePacks.id, kase.evidencePackId)).limit(1)
    : [];
  const [helper] = await db().select({ name: tables.helpers.name }).from(tables.helpers).where(eq(tables.helpers.userId, user.id)).limit(1);
  const history = await db().select().from(tables.auditLog).where(eq(tables.auditLog.subjectId, o.id)).orderBy(desc(tables.auditLog.seq)).limit(20);
  const amount = formatMoney({ cents: o.amountCents, currency: o.currency });
  const verdict = verification?.verdict ?? null;

  const asked: StatusWord = rb?.confirmedAt ? { word: 'Confirmed', glyph: '✓', tone: 'good' } : { word: 'Not confirmed', glyph: '…', tone: 'waiting' };
  const paid = paymentStatus(o);
  const arrived = shipmentStatus(shipment);
  const checked = verdictStatus(verdict?.kind);
  const caseState = caseStatus(kase?.stage);
  const moneyBack: StatusWord = verdict?.kind === 'match' && !kase ? { word: 'Nothing to do', glyph: '–', tone: 'neutral' } : caseState;
  const canMoneyBack = Boolean(verdict && verdict.kind !== 'match') && (!kase || kase.stage === 'evidence_built' || kase.stage === 'draft');
  const caseSent = Boolean(kase && kase.stage !== 'draft' && kase.stage !== 'evidence_built');

  return (
    <div className="grid gap-8">
      <FocusFromHash />
      <p>
        <Link className="link-target" href="/app/orders">
          All orders and money
        </Link>
      </p>
      <header className="grid gap-2">
        <p className="eyebrow">Order {o.id.slice(-8).toUpperCase()}</p>
        <h1 className="text-[length:var(--step-4)] max-w-[20ch]">{s.title}</h1>
        <p className="text-[length:var(--step-1)]">
          {[s.attributes.colour, s.attributes.size && `size ${s.attributes.size}`].filter(Boolean).join(', ')} · {amount} · Demo Store
        </p>
      </header>

      <ol className="folders">
        <Section n={1} id="asked" tab="Asked" state={asked}>
          <h3 className="folder-h">What you heard before paying</h3>
          <p>
            {s.title}
            {s.attributes.colour ? `, ${s.attributes.colour}` : ''}
            {s.attributes.size ? `, size ${s.attributes.size}` : ''}, {amount} with tax and shipping, from Demo Store.
          </p>
          {rb?.text && (
            <details className="tech">
              <summary>The full readback, word for word</summary>
              <p className="folder-said">{rb.text}</p>
            </details>
          )}
          {rb?.confirmedAt && <p className="muted">Confirmed {when(rb.confirmedAt)}.</p>}
          <Technical step="Asked" rows={[['Readback fingerprint', rb?.textHash]]} />
        </Section>

        <Section n={2} id="paid" tab="Paid" state={paid}>
          <h3 className="folder-h">
            {paid.word}. {paid.detail}
          </h3>
          <p>Amount: {amount}.</p>
          {o.receiptId && (
            <p>
              <Link className="link-target" href={`/receipts/${o.receiptId}`}>
                See the signed payment receipt
              </Link>
            </p>
          )}
          <Technical
            step="Paid"
            rows={[
              ['PayPal order', o.paypalOrderId],
              ['PayPal request id (stops double charges)', o.paypalRequestId],
              ['Authorization', o.authorizationId],
              ['Capture', o.captureId],
            ]}
          />
        </Section>

        <Section n={3} id="arrived" tab="Arrived" state={arrived}>
          <h3 className="folder-h">
            {shipment?.deliveredAt
              ? `Delivered ${spokenDate(shipment.deliveredAt)}.`
              : shipment?.trackingNumber
                ? `On its way with ${shipment.carrier}.`
                : 'Not shipped yet. I’ll tell you when it ships.'}
          </h3>
          {shipment?.trackingNumber && (
            <p>{shipment.trackerId ? 'Tracking is on the PayPal order.' : 'Tracking is recorded by Demo Store; it is added to PayPal when the payment is captured.'}</p>
          )}
          <Technical step="Arrived" rows={[['Tracking number', shipment?.trackingNumber]]} />
        </Section>

        <Section n={4} id="checked" tab="Checked" state={checked}>
          <h3 className="folder-h">{verdict ? verdict.headline : 'Not checked yet.'}</h3>
          {verdict && (
            <ul className="reason-list">
              {verdict.reasons.map((r, i) => (
                <li key={`${r.module}-${i}`} data-tone={FINDING[r.finding].tone}>
                  <span className="reason-glyph" aria-hidden="true">
                    {FINDING[r.finding].glyph}
                  </span>
                  <span>
                    <strong>
                      {MODULE_LABEL[r.module]}: {FINDING[r.finding].word}.
                    </strong>{' '}
                    {r.sentence}
                    {/* Most sentences already say how sure the check is; add it only when one doesn't. */}
                    {!/\bsure\b/i.test(r.sentence) && <span className="muted"> ({CONFIDENCE_WORD[r.confidence].toLowerCase()})</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {verification?.helperAnswer ? (
            <p className="mb-result">
              {helper?.name ?? 'Your helper'} answered:{' '}
              {(verification.helperAnswer as { answer: string }).answer === 'matches'
                ? 'it matches'
                : (verification.helperAnswer as { answer: string }).answer === 'different'
                  ? 'it is different'
                  : 'they could not tell'}
              .
              {(verification.helperAnswer as { note?: string }).note
                ? ` They said: “${(verification.helperAnswer as { note: string }).note.replace(/[.!?]+$/, '')}.”`
                : ''}
            </p>
          ) : verdict?.kind === 'unsure' && helper ? (
            <AskHelper orderId={o.id} helperName={helper.name} />
          ) : null}
          <p>
            <Link className={verdict ? 'btn' : 'btn btn-primary'} href={`/app/check/${o.id}`}>
              {verdict ? 'Check again' : 'Check the parcel with your camera'}
            </Link>
          </p>
        </Section>

        <Section n={5} id="money-back" tab="Money back" state={moneyBack}>
          <h3 className="folder-h">
            {caseSent
              ? kase!.stage === 'resolved'
                ? 'Resolved.'
                : `${caseState.word}.`
              : verdict && verdict.kind !== 'match'
                ? 'Get your money back'
                : 'Nothing to do here unless something is wrong.'}
          </h3>
          {caseSent && kase!.stage === 'seller_contacted' && kase!.dueAt && (
            <p>
              Demo Store has until {spokenDate(kase!.dueAt)} to reply. If they
              don’t, you can open a case with PayPal yourself and attach the signed evidence pack. I’ll tell you when anything changes.
            </p>
          )}
          {pack && (
            <p>
              <Link className="link-target" href={`/evidence/${pack.id}`}>
                Read the signed evidence pack
              </Link>
            </p>
          )}
          {(canMoneyBack || caseSent) && <MoneyBack orderId={o.id} canStart={canMoneyBack} sent={caseSent} done={null} />}
        </Section>
      </ol>

      <section aria-labelledby="hist-h" className="grid gap-3">
        <h2 id="hist-h" className="text-[length:var(--step-2)]">
          Everything that happened
        </h2>
        {history.length ? (
          <ol className="history">
            {history.map((h) => (
              <li key={h.seq}>
                {when(h.createdAt)}: {happened(h.action)}.
              </li>
            ))}
          </ol>
        ) : (
          <p>Nothing recorded for this order yet.</p>
        )}
        <p className="muted">Each line is chained to the one before it with a hash, so the history cannot be edited quietly.</p>
      </section>
    </div>
  );
}
