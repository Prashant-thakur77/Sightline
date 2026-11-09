import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import { tables } from '@sightline/db';
import { CONFIDENCE_WORD, FINDING, MODULE_LABEL, caseStatus, formatMoney, paymentStatus, shipmentStatus, spokenDate, verdictStatus, type StatusWord, shortRef } from '@sightline/core';
import { currentUser, requireUser } from '@/server/session';
import { orderForUser } from '@/server/orders-read';
import { db } from '@/server/runtime';
import { MoneyBack } from '@/components/orders/money-back';
import { AskHelper } from '@/components/orders/ask-helper';
import { FocusFromHash } from '@/components/orders/focus-from-hash';
import { spokenWhen } from '@/lib/when';

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

type Step = 'asked' | 'paid' | 'arrived' | 'checked' | 'money-back';

function Section({ n, id, tab, state, current, children }: { n: number; id: Step; tab: string; state: StatusWord; current: Step | null; children: React.ReactNode }) {
  const here = id === current;
  return (
    <li
      id={id}
      className="folder case-folder"
      data-tone={state.tone}
      data-current={here || undefined}
      style={{ ['--k' as string]: n - 1 }}
    >
      {/* The current step is said on its heading (where heading navigation lands) and shown in
          words on its tab, not by the yellow alone. */}
      <h2 className="folder-tab" aria-current={here ? 'step' : undefined}>
        <span className="case-glyph" aria-hidden="true">
          {state.glyph}
        </span>{' '}
        {tab}
        <span className="sr-only">, {state.word}</span>
        {here && (
          <span className="folder-now" aria-hidden="true">
            Now
          </span>
        )}
      </h2>
      <div className="folder-body case-body">{children}</div>
    </li>
  );
}

/** Times on this page are UTC and say so, in the same words as the orders page and what is said aloud. */
const when = spokenWhen;

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
  'case.offer_accepted': 'You accepted the offer',
  'case.offer_declined': 'You declined the offer',
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

/**
 * What a closed case ended with, from its recorded outcome, or from the order's own state when
 * the outcome has no kind (a PayPal decision gives a code instead).
 */
function resolvedOutcome(outcome: unknown, orderStatus: string, currency: string, amount: string): { head: string; detail: string | null } {
  const out = (outcome ?? {}) as { kind?: string; by?: string; amountCents?: number; outcome_code?: string };
  if (out.kind === 'replacement' || orderStatus === 'resolved_replacement')
    return { head: 'Resolved: you accepted a replacement.', detail: 'Demo Store sends a new one. No refund comes with it.' };
  if (out.kind === 'voided' || orderStatus === 'voided')
    return {
      head: 'Resolved: the payment hold was released.',
      detail:
        out.by === 'deadline'
          ? `The case wasn’t settled by its deadline, so I cancelled the hold. You were never charged ${amount}.`
          : `Demo Store released the hold. You were never charged ${amount}.`,
    };
  if (out.kind === 'refunded' || orderStatus === 'resolved_refund') {
    const refunded = typeof out.amountCents === 'number' ? formatMoney({ cents: out.amountCents, currency }) : amount;
    return { head: `Resolved: refunded ${refunded}.`, detail: 'It goes back to your PayPal account.' };
  }
  if (out.outcome_code === 'RESOLVED_BUYER_FAVOUR') return { head: 'Resolved: PayPal decided in your favour.', detail: 'Your refund comes through PayPal.' };
  if (out.outcome_code === 'RESOLVED_SELLER_FAVOUR') return { head: 'Resolved: PayPal decided for Demo Store.', detail: null };
  return { head: 'Resolved. The case is closed.', detail: null };
}

function Technical({ step, rows }: { step: string; rows: [string, string | null | undefined][] }) {
  const shown = rows.filter((r): r is [string, string] => Boolean(r[1]));
  if (!shown.length) return null;
  return (
    <details className="tech">
      <summary>
        <span className="tech-marker" aria-hidden="true" />
        Technical details: {step}
      </summary>
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
  // A helper link made earlier and still live (not answered, not cancelled, not expired).
  const [liveLink] = verification
    ? await db()
        .select({ expiresAt: tables.helperRequests.expiresAt })
        .from(tables.helperRequests)
        .where(
          and(
            eq(tables.helperRequests.verificationId, verification.id),
            isNull(tables.helperRequests.revokedAt),
            isNull(tables.helperRequests.answeredAt),
            gt(tables.helperRequests.expiresAt, new Date().toISOString()),
          ),
        )
        .orderBy(desc(tables.helperRequests.createdAt))
        .limit(1)
    : [];
  const liveHelperUntil = liveLink ? spokenWhen(liveLink.expiresAt) : null;
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
  const resolved = kase?.stage === 'resolved' ? resolvedOutcome(kase.outcome, o.status, o.currency, amount) : null;
  // The front (yellow) folder is where the order is now, read from the furthest step it reached:
  // a case or a wrong item, then the check, then payment still waiting, then the parcel on its way.
  // A closed case or a matching check leaves nothing to do: no folder is in front.
  const finished = kase?.stage === 'resolved' || (verdict?.kind === 'match' && !kase);
  const current: Step | null = finished
    ? null
    : kase || verdict?.kind === 'mismatch'
      ? 'money-back'
      : verdict || shipment?.deliveredAt
        ? 'checked'
        : !rb?.confirmedAt
          ? 'asked'
          : o.status === 'approval_pending' || o.status === 'confirmed' || o.status === 'failed'
            ? 'paid'
            : 'arrived';

  return (
    <div className="grid gap-8">
      <FocusFromHash />
      <p>
        <Link className="link-target" href="/app/orders">
          All orders and money
        </Link>
      </p>
      <header className="grid gap-2">
        <p className="eyebrow">Order {shortRef(o.id)}</p>
        <h1 className="text-[length:var(--step-4)] max-w-[20ch]">{s.title}</h1>
        <p className="text-[length:var(--step-1)]">
          {[s.attributes.colour, s.attributes.size && `size ${s.attributes.size}`].filter(Boolean).join(', ')} · {amount} · Demo Store
        </p>
      </header>

      <ol className="folders">
        <Section n={1} id="asked" tab="Asked" state={asked} current={current}>
          <h3 className="folder-h">What you heard before paying</h3>
          <p>
            {s.title}
            {s.attributes.colour ? `, ${s.attributes.colour}` : ''}
            {s.attributes.size ? `, size ${s.attributes.size}` : ''}, {amount} with tax and shipping, from Demo Store.
          </p>
          {rb?.text && (
            <details className="tech">
              <summary>
                <span className="tech-marker" aria-hidden="true" />
                The full readback, word for word
              </summary>
              <p className="folder-said">{rb.text}</p>
            </details>
          )}
          {rb?.confirmedAt && <p className="muted">Confirmed {when(rb.confirmedAt)}.</p>}
          <Technical step="Asked" rows={[['Readback fingerprint', rb?.textHash]]} />
        </Section>

        <Section n={2} id="paid" tab="Paid" state={paid} current={current}>
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

        <Section n={3} id="arrived" tab="Arrived" state={arrived} current={current}>
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

        <Section n={4} id="checked" tab="Checked" state={checked} current={current}>
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
          ) : verdict?.kind === 'unsure' && helper && kase?.stage !== 'resolved' ? (
            <AskHelper orderId={o.id} helperName={helper.name} waitingUntil={liveHelperUntil} primary={current === 'checked'} />
          ) : null}
          {/* Once the case is closed there is nothing a new check could change. */}
          {kase?.stage !== 'resolved' && (
            <p>
              <Link className={verdict ? 'btn' : 'btn btn-primary btn-xl'} href={`/app/check/${o.id}`}>
                {verdict ? 'Check again' : 'Check the parcel with your camera'}
              </Link>
            </p>
          )}
        </Section>

        <Section n={5} id="money-back" tab="Money back" state={moneyBack} current={current}>
          <h3 className="folder-h">
            {caseSent
              ? resolved
                ? resolved.head
                : `${caseState.word}.`
              : verdict && verdict.kind !== 'match'
                ? 'Get your money back'
                : verdict
                  ? 'Nothing to do. Your check matched.'
                  : 'Nothing to do yet.'}
          </h3>
          {!caseSent && !canMoneyBack && (
            <p>
              {verdict
                ? 'If you change your mind, or find something wrong later, check the parcel again. If the new check finds a problem, you can get your money back here.'
                : shipment?.deliveredAt
                  ? 'Your parcel was delivered. Check it with your camera. If it is not what you paid for, you can get your money back here.'
                  : 'When the parcel arrives, check it with your camera. If it is not what you paid for, you can get your money back here.'}
            </p>
          )}
          {resolved?.detail && <p>{resolved.detail}</p>}
          {caseSent && kase!.stage === 'seller_contacted' && kase!.dueAt && (
            <p className="mb-server-sent">
              Demo Store has until {spokenDate(kase!.dueAt)} to reply. If they
              don’t, you can open a case with PayPal yourself and attach the signed evidence pack. I’ll tell you when anything changes.
            </p>
          )}
          {kase?.stage === 'offer_received' && (
            <>
              <p>Demo Store made an offer, and nothing changes until you answer. I read the offer and what accepting it means, then you accept or decline it.</p>
              <p>
                <Link className="btn btn-primary btn-xl" href="/app?hear=offer">
                  Hear Demo Store’s offer and answer it
                </Link>
              </p>
            </>
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
