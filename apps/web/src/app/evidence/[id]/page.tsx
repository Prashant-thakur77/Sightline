import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { tables } from '@sightline/db';
import { formatMoney, reasonForSeller, verdictStatus, type ProductSnapshot, type Verdict } from '@sightline/core';
import { hashManifest, verifyHashSignature } from '@sightline/evidence';
import { SiteFooter, SiteHeader } from '@/components/shell/site-chrome';
import { db } from '@/server/runtime';
import { receiptKeyPair } from '@/server/keys';
import { currentUser } from '@/server/session';
import { existingBlobIds } from '@/server/blobs';
import { utcWhen } from '@/lib/when';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Evidence pack' };

export default async function EvidencePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [pack] = await db().select().from(tables.evidencePacks).where(eq(tables.evidencePacks.id, id)).limit(1);
  if (!pack) notFound();
  const user = await currentUser();
  const [ver] = pack.verificationId ? await db().select().from(tables.verifications).where(eq(tables.verifications.id, pack.verificationId)).limit(1) : [];
  const [owner] = await db().select({ userId: tables.orders.userId }).from(tables.orders).where(eq(tables.orders.id, pack.orderId)).limit(1);
  const isOwner = Boolean(user && owner && owner.userId === user.id);
  const present = isOwner && ver ? await existingBlobIds(ver.photos.map((p) => p.blobId)) : new Set<string>();
  const { ed25519, ...manifest } = pack.manifest as Record<string, unknown> & { ed25519?: string };
  const recomputed = hashManifest(manifest as never);
  const hashOk = recomputed === pack.manifestHash;
  const sigOk = ed25519 ? verifyHashSignature(pack.manifestHash, ed25519, receiptKeyPair().publicKeyHex) : false;
  const m = manifest as unknown as {
    order: { id: string; amount: { cents: number; currency: string }; paypalOrderId?: string; placedAt: string };
    readback: { text: string; textHash: string };
    snapshot: ProductSnapshot;
    files: { name: string; hash: string; takenAt: string; size?: number }[];
    verification: Verdict | { kind: 'none' };
    narrative: string;
  };
  const v = 'reasons' in m.verification ? m.verification : null;
  return (
    <>
    <SiteHeader />
    <main id="main" tabIndex={-1} className="w-full max-w-[960px] mx-auto px-[clamp(1rem,3vw,2.5rem)] py-[var(--space-7)] grid gap-8">
      {isOwner && (
        <p>
          <Link className="link-target" href={`/app/orders/${m.order.id}`}>
            Back to your order
          </Link>
        </p>
      )}
      <header className="grid gap-3">
        <p className="eyebrow">Evidence pack {pack.id}</p>
        <h1 className="text-[length:var(--step-4)] max-w-[22ch]">What was ordered, what arrived, and how we know</h1>
        <ul className="rchecks">
          <li className="rcheck" data-ok={String(hashOk)}>
            <span className="rcheck-mark" aria-hidden="true">
              {hashOk ? '✓' : '✕'}
            </span>
            <span>
              <strong>Fingerprint {hashOk ? 'matches' : 'does not match'}.</strong> Recomputed from every item below just now.
            </span>
          </li>
          <li className="rcheck" data-ok={String(sigOk)}>
            <span className="rcheck-mark" aria-hidden="true">
              {sigOk ? '✓' : '✕'}
            </span>
            <span>
              <strong>Signature {sigOk ? 'valid' : 'invalid'}.</strong> Ed25519, checkable offline with the public key.
            </span>
          </li>
        </ul>
      </header>

      <section aria-labelledby="ord-h" className="grid gap-3">
        <h2 id="ord-h" className="text-[length:var(--step-2)]">
          1. What was ordered
        </h2>
        <p>
          {m.snapshot.title}: {m.snapshot.attributes.colour ?? 'colour not listed'}, size {m.snapshot.attributes.size ?? 'not listed'},{' '}
          {formatMoney(m.order.amount)} from {m.snapshot.seller.name}, on {utcWhen(m.order.placedAt)}.
        </p>
        <p className="muted">
          Listing frozen at {utcWhen(m.snapshot.capturedAt)}. Its fingerprint starts <span className="mono">{m.snapshot.hash.slice(0, 16)}</span>.{' '}
          {m.order.paypalOrderId ? (
            <>
              PayPal order <span className="mono">{m.order.paypalOrderId}</span>.
            </>
          ) : (
            'No PayPal order exists for this order, so nothing was charged through PayPal.'
          )}
        </p>
      </section>

      <section aria-labelledby="rb-h" className="grid gap-3">
        <h2 id="rb-h" className="text-[length:var(--step-2)]">
          2. What the buyer heard before paying
        </h2>
        <div className="receipt evidence-ticket">
          <div className="receipt-edge" aria-hidden="true" />
          <p className="mono">{m.readback.text}</p>
          <div className="receipt-edge receipt-edge-bottom" aria-hidden="true" />
        </div>
      </section>

      <section aria-labelledby="ver-h" className="grid gap-3">
        <h2 id="ver-h" className="text-[length:var(--step-2)]">
          3. What arrived
        </h2>
        {v ? (
          <>
            {/* Told in the third person: the pack is read by the seller, not the buyer. */}
            <p className="text-[length:var(--step-1)]">The check&apos;s verdict: {verdictStatus(v.kind).word}.</p>
            <ul>
              {v.reasons.map((r, i) => (
                <li key={i}>{reasonForSeller(r)}</li>
              ))}
            </ul>
          </>
        ) : (
          <p>No photo check was run.</p>
        )}
        <h3>Photos</h3>
        {!isOwner && <p>The photos are shown only to the buyer. Their fingerprints are listed here, and the signed pack covers them.</p>}
        {isOwner && ver && (
          <ul className="ev-thumbs">
            {ver.photos.map((p) => (
              <li key={p.blobId}>
                {present.has(p.blobId) ? (
                  <img src={`/api/blobs/${p.blobId}`} alt={`What arrived: ${p.kind === 'label' ? 'the size tag' : p.kind === 'item' ? 'the item' : 'the damage'}.`} />
                ) : (
                  <p className="hint">Photo of {p.kind === 'label' ? 'the size tag' : p.kind === 'item' ? 'the item' : 'the damage'} deleted. Its fingerprint is still in the signed pack.</p>
                )}
              </li>
            ))}
          </ul>
        )}
        <ul>
          {m.files.map((f) => (
            <li key={f.hash}>
              {f.name}. Fingerprint starts <span className="mono">{f.hash.slice(0, 16)}</span>. Location data removed.
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="ask-h" className="grid gap-3">
        <h2 id="ask-h" className="text-[length:var(--step-2)]">
          4. What the buyer asks for
        </h2>
        <p>{m.narrative}</p>
      </section>
      <section aria-labelledby="verify-h" className="grid gap-3">
        <h2 id="verify-h" className="text-[length:var(--step-2)]">
          Check it yourself
        </h2>
        <p>
          Download the pack, save it in the repository&apos;s top folder, and run this command there. It needs no access to our server. The last
          part is this server&apos;s public key, so a pack signed with any other key fails.
        </p>
        <pre className="code">{`node scripts/verify-receipt.mjs evidence-${pack.id}.json ${receiptKeyPair().publicKeyHex}`}</pre>
        <p className="flex flex-wrap gap-3">
          <a className="btn" href={`/api/evidence/${pack.id}`} download>
            Download the evidence pack
          </a>
          <a className="btn" href="/.well-known/sightline-keys.json">
            Public key
          </a>
        </p>
      </section>
      <p className="muted mono">Manifest hash {pack.manifestHash}</p>
    </main>
    <SiteFooter />
    </>
  );
}
