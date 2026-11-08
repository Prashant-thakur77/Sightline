import { notFound } from 'next/navigation';
import Link from 'next/link';
import { CheckFlow } from '@/components/check/check-flow';
import { MomentsStrip } from '@/components/shell/moments';
import { requireUser } from '@/server/session';
import { orderForUser } from '@/server/orders-read';

export const metadata = { title: 'Check your parcel' };

export default async function CheckPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  const user = await requireUser();
  const found = await orderForUser(orderId, user.id);
  if (!found || !found.snapshot) notFound();
  const s = found.snapshot;
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
        <Link href={`/app/orders/${orderId}`}>Back to the order</Link>
      </p>
      <header className="grid gap-2">
        <MomentsStrip done={3} current="Checked" />
        <p className="eyebrow">Order {found.order.id}</p>
        <h1 className="text-[length:var(--step-4)] max-w-[18ch]">Is this the {s.title} you paid for?</h1>
        <p className="text-[length:var(--step-1)] max-w-[var(--measure)]">
          You ordered {s.attributes.colour ?? 'the listed colour'}, size {s.attributes.size ?? 'as listed'}.{' '}
          {found.order.status === 'authorized' ? 'Your payment is on hold. Demo Store is paid only if this matches.' : ''}
        </p>
      </header>
      <CheckFlow
        orderId={orderId}
        itemName={s.title.toLowerCase()}
        ordered={{ title: s.title, imageUrl: s.images[0]?.url, colour: s.attributes.colour, size: s.attributes.size }}
        demoShots={demoShots}
        initial={
          found.verification?.verdict
            ? {
                verdict: found.verification.verdict,
                itemPhoto: found.verification.photos.find((p) => p.kind === 'item')
                  ? `/api/blobs/${found.verification.photos.find((p) => p.kind === 'item')!.blobId}`
                  : undefined,
              }
            : null
        }
      />
    </div>
  );
}
