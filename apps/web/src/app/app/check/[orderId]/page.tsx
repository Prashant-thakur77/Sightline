import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { cache } from 'react';
import { CheckFlow } from '@/components/check/check-flow';
import { MomentsStrip, type Moment } from '@/components/shell/moments';
import { currentUser, requireUser } from '@/server/session';
import { orderForUser } from '@/server/orders-read';
import { existingBlobIds } from '@/server/blobs';
import { paymentStatus, shortRef } from '@sightline/core';
import { eq } from 'drizzle-orm';
import { tables } from '@sightline/db';
import { db } from '@/server/runtime';

/** One read per request: the title and the page share it. */
const loadOrder = cache(orderForUser);

export async function generateMetadata({ params }: { params: Promise<{ orderId: string }> }): Promise<Metadata> {
  const { orderId } = await params;
  const user = await currentUser();
  // Without a session the layout sends the person to /start, so this title is never seen.
  if (!user) return { title: 'Check your parcel' };
  // An order that isn't there gets the not-found page's title, not this one. (The page itself
  // shows the not-found page; throwing here too renders it a second, different way.)
  const found = await loadOrder(orderId, user.id);
  return { title: found?.snapshot ? 'Check your parcel' : 'Not found' };
}

/** What a helper's answer was, in the words the order page uses. */
function helperWords(name: string, a: { answer?: string; note?: string } | null | undefined): string | null {
  if (!a?.answer) return null;
  const said = a.answer === 'matches' ? 'it matches' : a.answer === 'different' ? 'it is different' : 'they could not tell';
  return `${name} answered: ${said}.${a.note ? ` They said: “${a.note.replace(/[.!?]+$/, '')}.”` : ''}`;
}

export default async function CheckPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  const user = await requireUser();
  const found = await loadOrder(orderId, user.id);
  if (!found || !found.snapshot) notFound();
  const s = found.snapshot;
  const [helper] = await db().select({ name: tables.helpers.name }).from(tables.helpers).where(eq(tables.helpers.userId, user.id)).limit(1);
  // The strip says Paid only when PayPal holds or took the money, never just because it arrived.
  const pay = paymentStatus(found.order);
  const paid = pay.word === 'Paid' || pay.word === 'On hold';
  const kase = found.kase;
  const caseStage = kase && kase.stage !== 'draft' && kase.stage !== 'evidence_built' ? kase.stage : null;
  const verdictKind = found.verification?.verdict?.kind;
  // The five moments from what is recorded: moments that did not happen say so instead of a tick.
  const notDone: Partial<Record<Moment, string>> = {};
  if (!paid) notDone.Paid = 'not paid';
  if (!found.shipment?.deliveredAt) notDone.Arrived = 'not delivered yet';
  let done = 3;
  let current: Moment | undefined = 'Checked';
  let currentNote = 'now';
  if (verdictKind && caseStage === 'resolved') {
    done = 5;
    current = undefined;
  } else if (verdictKind === 'match' && !caseStage) {
    done = 5;
    current = undefined;
    notDone['Money back'] = 'not needed';
  } else if (verdictKind) {
    done = 4;
    current = 'Money back';
    currentNote = caseStage ? 'in progress' : 'next, if you want it';
  }
  const helperAnswer = helperWords(helper?.name ?? 'Your helper', found.verification?.helperAnswer as { answer?: string; note?: string } | null);
  const itemRecord = found.verification?.photos.find((p) => p.kind === 'item') as { blobId: string; source?: string } | undefined;
  const itemBlob = itemRecord?.blobId;
  const itemSource = itemRecord?.source === 'camera' || itemRecord?.source === 'upload' || itemRecord?.source === 'demo' ? itemRecord.source : undefined;
  const itemPhotoKept = itemBlob ? (await existingBlobIds([itemBlob])).has(itemBlob) : false;
  const shipped = found.shipment?.shippedVariant;
  // Demo parcel photos match what the Demo Store merchant shipped (set with the demo controls).
  const demoShots =
    user.isDemo && shipped
      ? shipped === 'correct'
        ? [
            { kind: 'item' as const, url: '/demo-parcel/right-item.jpg' },
            { kind: 'label' as const, url: '/demo-parcel/right-tag.jpg' },
          ]
        : [
            { kind: 'item' as const, url: '/demo-parcel/wrong-item.jpg' },
            { kind: 'label' as const, url: '/demo-parcel/wrong-tag.jpg' },
          ]
      : undefined;
  return (
    <div className="grid gap-6">
      <p>
        <Link className="link-target" href={`/app/orders/${orderId}`}>
          Back to the order
        </Link>
      </p>
      <header className="grid gap-2">
        <MomentsStrip done={done} current={current} currentNote={currentNote} notDone={notDone} />
        <p className="eyebrow">Order {shortRef(found.order.id)}</p>
        <h1 className="text-[length:var(--step-4)] max-w-[18ch]">Is this the {s.title} you paid for?</h1>
        <p className="text-[length:var(--step-1)] max-w-[var(--measure)]">
          You ordered {s.attributes.colour ?? 'the listed colour'}, size {s.attributes.size ?? 'as listed'}.{' '}
          {pay.word === 'On hold' ? 'Your payment is on hold. Demo Store is paid only if this matches.' : ''}
        </p>
      </header>
      <CheckFlow
        orderId={orderId}
        itemName={s.title}
        helperName={helper?.name ?? null}
        helperAnswer={helperAnswer}
        caseStage={caseStage}
        ordered={{ title: s.title, imageUrl: s.images[0]?.url, colour: s.attributes.colour, size: s.attributes.size }}
        demoShots={demoShots}
        initial={
          found.verification?.verdict
            ? {
                verdict: found.verification.verdict,
                itemPhoto: itemBlob && itemPhotoKept ? `/api/blobs/${itemBlob}` : undefined,
                itemPhotoSource: itemSource,
              }
            : null
        }
      />
    </div>
  );
}
