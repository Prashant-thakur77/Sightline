import type { Metadata } from 'next';
import { cache } from 'react';
import { Wordmark } from '@/components/shell/mark';
import { resolveHelperToken } from '@/server/helper';
import { HelperAnswer } from './helper-answer';

export const dynamic = 'force-dynamic';

/** One read per request: the title and the page share it. */
const resolve = cache(resolveHelperToken);

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  const { token } = await params;
  const r = await resolve(decodeURIComponent(token));
  return { title: r ? 'Can you take a look?' : 'Link not working', robots: { index: false } };
}

export default async function HelperPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const r = await resolve(decodeURIComponent(token));
  return (
    <main id="main" tabIndex={-1} className="w-full max-w-[880px] mx-auto px-[clamp(1rem,3vw,2.5rem)] py-[var(--space-7)] grid gap-7">
      <Wordmark size={24} />
      {!r ? (
        <section className="grid gap-3">
          {/* An expired, cancelled and mistyped link all look the same from here, so the page doesn't guess which. */}
          <h1 className="text-[length:var(--step-4)]">This link doesn’t work any more</h1>
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
          {/* Each photo links to the full-size image. The figure's caption (its name for screen readers) says what it shows, so the image has no alt text that would repeat it. */}
          <ul className="helper-photos" aria-label="Photos">
            {r.snapshot.images[0] && (
              <li>
                <figure>
                  <a className="helper-photo" href={r.snapshot.images[0].url}>
                    <img src={r.snapshot.images[0].url} alt="" />
                    <span>Open the listing photo full size (opens in this tab)</span>
                  </a>
                  <figcaption>
                    <span className="verdict-cap">What was ordered</span>
                    <span>{r.snapshot.title}</span>
                    <span>{[r.snapshot.attributes.colour, r.snapshot.attributes.size && `size ${r.snapshot.attributes.size}`].filter(Boolean).join(', ')}</span>
                  </figcaption>
                </figure>
              </li>
            )}
            {r.photos.map((p) => {
              const what = p.kind === 'label' ? 'size tag' : p.kind === 'item' ? 'item' : 'damage';
              const src = `/api/helper/${encodeURIComponent(token)}/photo/${p.kind}`;
              return (
                <li key={p.kind}>
                  <figure>
                    <a className="helper-photo" href={src}>
                      <img src={src} alt="" />
                      <span>Open the {what} photo full size (opens in this tab)</span>
                    </a>
                    <figcaption>
                      <span className="verdict-cap">What arrived, from {r.buyerName}’s camera</span>
                      <span>{p.kind === 'label' ? 'Size tag' : p.kind === 'item' ? 'The item' : 'Damage'}</span>
                    </figcaption>
                  </figure>
                </li>
              );
            })}
          </ul>
          <HelperAnswer token={token} answered={Boolean(r.request.answeredAt)} buyerName={r.buyerName} />
        </>
      )}
    </main>
  );
}
