import { PublicPage } from '@/components/landing/public-page';
import { PAYPAL } from '@/components/landing/content';

export const metadata = { title: 'PayPal and your money' };

export default function PayPalPage() {
  return (
    <PublicPage
      path="/paypal"
      kicker="PayPal and your money"
      title="The money waits for the check."
      lede="PayPal holds the payment instead of taking it. The store is paid only when the parcel is right. Everything here runs in PayPal’s sandbox."
    >
      <section id="money" className="lx-section lx-money" aria-labelledby="money-h">
        <div className="lx-wrap">
          <h2 id="money-h" className="lx-h2">
            Pay after check, step by step
          </h2>
          <ol className="lx-flow" aria-label="Pay after check, step by step">
            <li>
              <span className="lx-flow-k">Buy</span>
              <span>PayPal authorizes $36.72. Nothing is taken yet.</span>
            </li>
            <li>
              <span className="lx-flow-k">Check</span>
              <span>You check the parcel with your camera.</span>
            </li>
            <li data-tone="good">
              <span className="lx-flow-k">
                <span aria-hidden="true">✓ </span>It matches
              </span>
              <span>PayPal captures the payment. The store is paid.</span>
            </li>
            <li data-tone="bad">
              <span className="lx-flow-k">
                <span aria-hidden="true">✕ </span>It is wrong
              </span>
              <span>The store fixes it, or PayPal releases the hold. If the store does not answer in 3 business days, the hold is released anyway.</span>
            </li>
          </ol>
          <h3 className="lx-h3">Built on PayPal, end to end</h3>
          <ul className="lx-apis">
            {PAYPAL.map(([api, what]) => (
              <li key={api}>
                <strong>{api}</strong>
                <span>{what}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </PublicPage>
  );
}
