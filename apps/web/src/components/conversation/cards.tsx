'use client';

import Link from 'next/link';
import type { Card, OptionItem } from './types';
import { MomentsStrip } from '@/components/shell/moments';

function OptionCard({ item, onChoose, onBuy }: { item: OptionItem; onChoose: (i: number) => void; onBuy: (i: number) => void }) {
  const id = `opt-${item.index}`;
  return (
    <li className="option" aria-labelledby={`${id}-t`}>
      <span className="option-num" aria-hidden="true">
        {item.index}
      </span>
      {item.imageUrl && <img className="option-img" src={item.imageUrl} alt={item.imageAlt ?? ''} />}
      <div className="option-body">
        <h3 id={`${id}-t`} className="option-title">
          <span className="sr-only">Option {item.index}: </span>
          {item.title}
        </h3>
        <dl className="option-facts">
          <div>
            <dt>Price</dt>
            <dd>{item.price}</dd>
          </div>
          <div>
            <dt>Colour</dt>
            <dd>{item.colour ?? 'Not listed'}</dd>
          </div>
          <div>
            <dt>Size</dt>
            <dd>{item.size ?? 'Not listed'}</dd>
          </div>
          <div>
            <dt>Returns</dt>
            <dd>{item.returns}</dd>
          </div>
        </dl>
        {item.pick && <p className="hint">{item.pick}</p>}
        {!item.available && <p className="option-warn">Out of stock in this size.</p>}
        <div className="option-actions">
          <button type="button" className="btn" onClick={() => onChoose(item.index)} aria-describedby={`${id}-t`}>
            Details
          </button>
          <button type="button" className="btn btn-primary" onClick={() => onBuy(item.index)} aria-describedby={`${id}-t`} disabled={!item.available}>
            Buy this
          </button>
        </div>
      </div>
    </li>
  );
}

export function CardView({
  card,
  onChoose,
  onBuy,
  onConfirm,
  onHold,
  onCancel,
  onOffer,
  paypalSlot,
}: {
  card: Card;
  onChoose: (i: number) => void;
  onBuy: (i: number) => void;
  onConfirm: (readbackId: string) => void;
  onHold: (readbackId: string) => void;
  onCancel: () => void;
  /** Accept (two presses) or decline the store's offer on the card. */
  onOffer: (answer: 'accept' | 'decline', offerId: string) => void;
  paypalSlot?: React.ReactNode;
}) {
  switch (card.kind) {
    case 'options':
      return (
        <section aria-labelledby="card-h" className="card">
          <h2 id="card-h" tabIndex={-1} className="card-h">
            {card.heading}
          </h2>
          <ol className="options" aria-label={`${card.items.length} options`}>
            {card.items.map((it) => (
              <OptionCard key={it.productId} item={it} onChoose={onChoose} onBuy={onBuy} />
            ))}
          </ol>
        </section>
      );
    case 'details':
      return (
        <section aria-labelledby="card-h" className="card">
          <h2 id="card-h" tabIndex={-1} className="card-h">
            {card.heading}
          </h2>
          <div className="details">
            {card.item.imageUrl && <img className="details-img" src={card.item.imageUrl} alt={card.item.imageAlt ?? ''} />}
            <dl className="details-facts">
              {card.facts.map((f) => (
                <div key={f.label}>
                  <dt>{f.label}</dt>
                  <dd>
                    {f.value}
                    {f.source && <span className="fact-src"> · from the {f.source}</span>}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
          {card.quotes.length > 0 && (
            <div className="grid gap-3">
              <h3 className="text-[length:var(--step-1)]">What reviewers say, quoted</h3>
              {card.quotes.map((q) => (
                <blockquote key={q.text} className="quote">
                  <p>“{q.text}”</p>
                  <footer>{q.source}</footer>
                </blockquote>
              ))}
            </div>
          )}
          <div className="option-actions">
            <button type="button" className="btn btn-primary btn-xl" onClick={() => onBuy(card.item.index)} disabled={!card.item.available}>
              Buy this
            </button>
          </div>
        </section>
      );
    case 'compare':
      return (
        <section aria-labelledby="card-h" className="card">
          <h2 id="card-h" tabIndex={-1} className="card-h">
            {card.heading}
          </h2>
          {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrollable region must be reachable by keyboard (WCAG 2.1.1) */}
          <div className="table-wrap" tabIndex={0} role="region" aria-label="Comparison table, scrolls sideways">
            <table className="compare">
              <thead>
                <tr>
                  <td />
                  {card.columns.map((c) => (
                    <th key={c} scope="col">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {card.rows.map((r) => (
                  <tr key={r.label}>
                    <th scope="row">{r.label}</th>
                    {r.values.map((v, i) => (
                      <td key={i}>{v}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      );
    case 'readback':
      return (
        <section aria-labelledby="card-h" className="card card-readback">
          <h2 id="card-h" tabIndex={-1} className="card-h">
            {card.heading}
          </h2>
          {/* Paying is the step being decided, but nothing is paid until the buyer confirms. */}
          <MomentsStrip done={1} current="Paid" currentNote="not yet, waiting for you to confirm" />
          <div className="receipt" role="group" aria-label="Readback">
            <div className="receipt-edge" aria-hidden="true" />
            <dl className="receipt-lines">
              {card.fields.map((f) => (
                <div key={f.key} className="receipt-line" data-key={f.key}>
                  <dt>{f.label}</dt>
                  <dd>{f.value}</dd>
                </div>
              ))}
            </dl>
            {/* The KEEP stub of the ticket design: the word is the motif, the sentence is the point. */}
            <p className="receipt-stub">
              <span aria-hidden="true">Keep</span>
              <span>This is your proof.</span>
            </p>
            <div className="receipt-edge receipt-edge-bottom" aria-hidden="true" />
          </div>
          {/* After the receipt in reading order; on wide screens shown beside it and kept in view. */}
          <div className="card-actions">
            {card.held && <p className="receipt-note">Holding. Take your time. Nothing happens until you confirm.</p>}
            {/* data-action lets focus stay on the same control when this card is shown again
                (after a first press, or after Wait). */}
            <div className="confirm-row">
              <button
                type="button"
                className="btn btn-primary btn-xl"
                onClick={() => onConfirm(card.readbackId)}
                aria-keyshortcuts="Shift+Enter"
                aria-describedby={card.paypalConnected ? undefined : 'paypal-off'}
                data-action="confirm"
              >
                {card.needsSecondPress ? `Press again to pay ${card.total}` : `Confirm and pay ${card.total}`}
              </button>
              <button type="button" className="btn btn-xl" onClick={() => onHold(card.readbackId)} data-action="hold">
                Wait, hold on
              </button>
              <button type="button" className="btn btn-xl" onClick={onCancel} data-action="cancel">
                Cancel
              </button>
            </div>
            {card.paypalConnected ? (
              <p className="receipt-note">Paying with {card.payWith}. To pay by voice, hold Talk while you say ‘confirm purchase’. To change something, say what to change.</p>
            ) : (
              // Also the Confirm button's description, so it is heard before the first press.
              <p id="paypal-off" className="receipt-note receipt-warn">
                PayPal isn’t connected on this server, so confirming won’t charge anything. To change something, say what to change.
              </p>
            )}
          </div>
        </section>
      );
    case 'offer':
      return (
        <section aria-labelledby="card-h" className="card card-offer">
          <h2 id="card-h" tabIndex={-1} className="card-h">
            {card.heading}
          </h2>
          <p className="max-w-[var(--measure)]">{card.text}</p>
          {card.reasons && card.reasons.length > 0 && (
            <div className="offer-why">
              <h3 id="card-why-h" className="font-bold">
                {card.byAgent ? 'Why the store’s agent offered this' : 'Why the store offered this'}
              </h3>
              <ul aria-labelledby="card-why-h" className="max-w-[var(--measure)]">
                {card.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </div>
          )}
          {/* data-action keeps focus on Accept between its two presses, as with Confirm. */}
          <div className="confirm-row">
            <button type="button" className="btn btn-primary btn-xl" onClick={() => onOffer('accept', card.offerId)} data-action="offer-accept">
              {card.needsSecondPress ? 'Press again to accept' : 'Accept the offer'}
            </button>
            <button type="button" className="btn btn-xl" onClick={() => onOffer('decline', card.offerId)} data-action="offer-decline">
              Decline
            </button>
          </div>
          <p className="receipt-note">
            Nothing changes until you choose. Declining keeps your case open.{' '}
            <Link href={`/app/orders/${card.orderId}#money-back`}>See the order</Link>
          </p>
        </section>
      );
    case 'paypal':
      return (
        <section aria-labelledby="card-h" className="card">
          <h2 id="card-h" tabIndex={-1} className="card-h">
            {card.heading}
          </h2>
          <p>
            This is your first purchase, so PayPal will ask you to log in once. After that, {card.total} is approved and your PayPal is saved
            for next time.
          </p>
          {paypalSlot}
        </section>
      );
    case 'paid':
      return (
        <section aria-labelledby="card-h" className="card card-paid">
          <h2 id="card-h" tabIndex={-1} className="card-h">
            {card.heading}
          </h2>
          <MomentsStrip done={2} current="Arrived" />
          <p className="text-[length:var(--step-1)]">
            {card.payAfterCheck
              ? `${card.amount} is on hold with PayPal. ${card.merchant} only gets paid after you check the parcel.`
              : `${card.amount} paid to ${card.merchant}.`}
          </p>
          <div className="option-actions">
            <Link className="btn" href={`/app/orders/${card.orderId}`}>
              See the order
            </Link>
            {card.receiptId && (
              <Link className="btn" href={`/receipts/${card.receiptId}`}>
                See the signed receipt
              </Link>
            )}
          </div>
        </section>
      );
    case 'refusal':
      return (
        <section aria-labelledby="card-h" className="card card-refusal">
          <h2 id="card-h" tabIndex={-1} className="card-h">
            {card.heading}
          </h2>
          <p>{card.reason}</p>
        </section>
      );
    case 'help':
      return (
        <section aria-labelledby="card-h" className="card">
          <h2 id="card-h" tabIndex={-1} className="card-h">
            {card.heading}
          </h2>
          <div className="help-groups">
            {card.groups.map((g) => (
              <div key={g.title}>
                <h3>{g.title}</h3>
                <ul>
                  {g.phrases.map((p) => (
                    <li key={p}>“{p}”</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      );
    case 'link':
      return (
        <section aria-labelledby="card-h" className="card">
          <h2 id="card-h" tabIndex={-1} className="card-h">
            {card.heading}
          </h2>
          <p>{card.text}</p>
          <Link className="btn btn-xl" href={card.href}>
            {card.label}
          </Link>
        </section>
      );
  }
}
