import { PRODUCT_NAME } from '@sightline/core';
import { Journey } from '@/components/landing/journey';
import { PublicPage } from '@/components/landing/public-page';
import { STEPS } from '@/components/landing/content';

export const metadata = { title: 'How it works' };

export default function How() {
  return (
    <PublicPage
      path="/how"
      kicker="How it works"
      title="One voice, from asking to money back."
      lede={`Five moments with ${PRODUCT_NAME}. You stay in charge of every one.`}
    >
      <section className="lx-section lx-journey" aria-labelledby="how-h">
        <div className="lx-wrap">
          <h2 id="how-h" className="lx-h2">
            The five moments
          </h2>
          <Journey steps={STEPS} />
        </div>
      </section>
    </PublicPage>
  );
}
