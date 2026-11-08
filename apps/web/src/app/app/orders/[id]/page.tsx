import Link from 'next/link';
import { notFound } from 'next/navigation';
import { desc, eq } from 'drizzle-orm';
import { tables } from '@sightline/db';
import { formatMoney } from '@sightline/core';
import { requireUser } from '@/server/session';
import { orderForUser } from '@/server/orders-read';
import { db } from '@/server/runtime';
import { MoneyBack } from '@/components/orders/money-back';
import { AskHelper } from '@/components/orders/ask-helper';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Order' };

const PAID_WORDS: Record<string, string> = {
  authorized: 'On hold with PayPal. Demo Store is paid only after your check matches.',
  captured: 'Paid to Demo Store.',
  verified_match: 'Paid to Demo Store after your check matched.',
  voided: 'Hold cancelled. Demo Store was never paid.',
  approval_pending: 'Waiting for your approval in PayPal.',
  failed: 'Not placed. Nothing was charged.',
};

function Section({ n, id, tab, done, children }: { n: number; id: string; tab: string; done: boolean; children: React.ReactNode }) {
  return (
    <li id={id} className="folder case-folder" data-done={done || undefined} style={{ ['--k' as string]: n - 1 }}>
      <h2 className="folder-tab">
        <span className="sr-only">Step {n}: </span>
        {tab}
        <span className="case-state">
          <span aria-hidden="true">{done ? ' ✓' : ''}</span>
          <span className="sr-only">{done ? ', done' : ', not yet'}</span>
        </span>
      </h2>
      <div className="folder-body case-body">{children}</div>
    </li>
  );
}

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const found = await orderForUser(id, user.id);
  if (!found || !found.snapshot) notFound();
  const { order: o, snapshot: s, shipment, verification, kase } = found;
  const [rb] = await db().select().from(tables.readbacks).where(eq(tables.readbacks.id, o.readbackId)).limit(1);
  const [pack] = kase?.evidencePackId
    ? await db().select().from(tables.evidencePacks).where(eq(tables.evidencePacks.id, kase.evidencePackId)).limit(1)
    : [];
  const [helper] = await db().select({ name: tables.helpers.name }).from(tables.helpers).where(eq(tables.helpers.userId, user.id)).limit(1);
  const history = await db().select().from(tables.auditLog).where(eq(tables.auditLog.subjectId, o.id)).orderBy(desc(tables.auditLog.seq)).limit(20);
  const amount = formatMoney({ cents: o.amountCents, currency: o.currency });
  const verdict = verification?.verdict;
  const canMoneyBack = Boolean(verdict && verdict.kind !== 'match') && (!kase || kase.stage === 'evidence_built' || kase.stage === 'draft');
  const caseDone = kase && kase.stage !== 'draft' && kase.stage !== 'evidence_built';

  return (
    <div className="grid gap-8">
      <p>
        <Link href="/app/orders">All orders and money</Link>
      </p>
      <header className="grid gap-2">
        <p className="eyebrow">Order {o.id}</p>
        <h1 className="text-[length:var(--step-4)] max-w-[20ch]">{s.title}</h1>
        <p className="text-[length:var(--step-1)]">
          {[s.attributes.colour, s.attributes.size && `size ${s.attributes.size}`].filter(Boolean).join(', ')} · {amount} · Demo Store
        </p>
      </header>

      <ol className="folders">
        <Section n={1} id="asked" tab="Asked" done>
          <h3 className="folder-h">What you heard before paying</h3>
          <p className="folder-said">{rb?.text}</p>
          <p className="muted">
            Readback fingerprint <span className="mono">{rb?.textHash.slice(0, 16)}…</span>
            {rb?.confirmedAt && ` · confirmed ${new Date(rb.confirmedAt).toLocaleString('en-US')}`}
          </p>
        </Section>

        <Section n={2} id="paid" tab="Paid" done={['authorized', 'captured', 'verified_match', 'voided', 'case_open', 'shipped', 'delivered'].includes(o.status)}>
          <h3 className="folder-h">{PAID_WORDS[o.status] ?? `${amount} through PayPal.`}</h3>
          <dl className="details-facts">
            <div>
              <dt>Amount</dt>
              <dd>{amount}</dd>
            </div>
            <div>
              <dt>PayPal order</dt>
              <dd className="mono">{o.paypalOrderId ?? 'Not created'}</dd>
            </div>
            <div>
              <dt>Request id (stops double charges)</dt>
              <dd className="mono">{o.paypalRequestId}</dd>
            </div>
          </dl>
          {o.receiptId && (
            <p>
              <Link href={`/receipts/${o.receiptId}`}>See the signed payment receipt</Link>
            </p>
          )}
        </Section>

        <Section n={3} id="arrived" tab="Arrived" done={Boolean(shipment?.deliveredAt)}>
          <h3 className="folder-h">
            {shipment?.deliveredAt
              ? `Delivered ${new Date(shipment.deliveredAt).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}.`
              : shipment?.trackingNumber
                ? `On its way with ${shipment.carrier}.`
                : 'Not shipped yet. I’ll tell you when it ships.'}
          </h3>
          {shipment?.trackingNumber && (
            <p>
              Tracking number <span className="mono">{shipment.trackingNumber}</span>, added to the PayPal order.
            </p>
          )}
        </Section>

        <Section n={4} id="checked" tab="Checked" done={Boolean(verdict)}>
          <h3 className="folder-h">{verdict ? verdict.headline : 'Not checked yet.'}</h3>
          {verification?.helperAnswer ? (
            <p className="mb-result">
              {helper?.name ?? 'Your helper'} answered: {(verification.helperAnswer as { answer: string }).answer === 'matches' ? 'it matches' : (verification.helperAnswer as { answer: string }).answer === 'different' ? 'it is different' : 'could not tell'}.
            </p>
          ) : verdict?.kind === 'unsure' && helper ? (
            <AskHelper orderId={o.id} helperName={helper.name} />
          ) : null}
          <p>
            <Link className="btn btn-primary" href={`/app/check/${o.id}`}>
              {verdict ? 'Check again' : 'Check the parcel with your camera'}
            </Link>
          </p>
        </Section>

        <Section n={5} id="money-back" tab="Money back" done={Boolean(caseDone)}>
          <h3 className="folder-h">
            {kase?.stage === 'resolved'
              ? 'Resolved.'
              : kase?.stage === 'seller_contacted'
                ? 'Sent to Demo Store. Waiting for their reply.'
                : verdict && verdict.kind !== 'match'
                  ? 'Get your money back'
                  : 'Nothing to do here unless something is wrong.'}
          </h3>
          {pack && (
            <p>
              <Link href={`/evidence/${pack.id}`}>Evidence pack</Link> · fingerprint <span className="mono">{pack.manifestHash.slice(0, 16)}…</span>
            </p>
          )}
          <MoneyBack orderId={o.id} canStart={canMoneyBack} done={caseDone ? null : null} />
        </Section>
      </ol>

      <section aria-labelledby="hist-h" className="grid gap-3">
        <h2 id="hist-h" className="text-[length:var(--step-2)]">
          Everything that happened
        </h2>
        <ol className="history">
          {history.map((h) => (
            <li key={h.seq}>
              <span className="mono">{new Date(h.createdAt).toLocaleString('en-US')}</span> · {h.action.replace(/[._]/g, ' ')} · by {h.actor}
            </li>
          ))}
        </ol>
        <p className="muted">Each line is chained to the one before it with a hash, so the history cannot be edited quietly.</p>
      </section>
    </div>
  );
}
