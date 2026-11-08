import { Wordmark } from '@/components/shell/mark';
import { resolveHelperToken } from '@/server/helper';
import { HelperAnswer } from './helper-answer';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Can you take a look?', robots: { index: false } };

export default async function HelperPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const r = await resolveHelperToken(decodeURIComponent(token));
  return (
    <main id="main" tabIndex={-1} className="w-full max-w-[880px] mx-auto px-[clamp(1rem,3vw,2.5rem)] py-[var(--space-7)] grid gap-7">
      <Wordmark size={24} />
      {!r ? (
        <section className="grid gap-3">
          <h1 className="text-[length:var(--step-4)]">This link has expired</h1>
          <p className="text-[length:var(--step-1)]">Links for helpers last 48 hours and can be cancelled at any time. Nothing else is needed from you.</p>
        </section>
      ) : (
        <>
          <header className="grid gap-3">
            <p className="eyebrow">A request from {r.buyerName}</p>
            <h1 className="text-[length:var(--step-4)] max-w-[22ch]">{r.request.question}</h1>
            <p className="text-[length:var(--step-1)]">
              {r.buyerName} checked a delivery with their phone camera and the app was not sure. You only see the photos and the listing. You can’t see or
              move any money.
            </p>
          </header>
          <div className="verdict-compare">
            <figure>
              {r.snapshot.images[0] && <img src={r.snapshot.images[0].url} alt={`The ${r.snapshot.title} as listed.`} />}
              <figcaption>
                <span className="verdict-cap">What was ordered</span>
                <span>{r.snapshot.title}</span>
                <span>{[r.snapshot.attributes.colour, r.snapshot.attributes.size && `size ${r.snapshot.attributes.size}`].filter(Boolean).join(', ')}</span>
              </figcaption>
            </figure>
            {r.photos.map((p) => (
              <figure key={p.kind}>
                <img src={`/api/helper/${encodeURIComponent(token)}/photo/${p.kind}`} alt={`What arrived, from ${r.buyerName}'s camera: the ${p.kind === 'label' ? 'size tag' : p.kind === 'item' ? 'item' : 'damage'}.`} />
                <figcaption>
                  <span className="verdict-cap">What arrived</span>
                  <span>{p.kind === 'label' ? 'Size tag' : p.kind === 'item' ? 'The item' : 'Damage'}</span>
                </figcaption>
              </figure>
            ))}
          </div>
          {r.verdict && <p>The app said: “{r.verdict.headline}”</p>}
          <HelperAnswer token={token} answered={Boolean(r.request.answeredAt)} buyerName={r.buyerName} />
        </>
      )}
    </main>
  );
}
