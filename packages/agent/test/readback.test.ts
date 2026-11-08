import { describe, expect, it } from 'vitest';
import type { ProductSnapshot } from '@sightline/core';
import { hashCart, hashReadbackBinding, hashReadbackText } from '@sightline/evidence';
import { ReadbackError, composeReadback, deliveryPhrase, type ComposeReadbackInput } from '../src/readback';
import { NOW, SAVED_PAYPAL, TUE_17_NOV, cart, snapshot, usd } from './helpers';

function input(over: Partial<ComposeReadbackInput> = {}): ComposeReadbackInput {
  return {
    cart: cart([{ snapshot: snapshot(), quantity: 1 }]),
    paymentSource: SAVED_PAYPAL,
    deliveryEstimate: TUE_17_NOV,
    locale: 'en-US',
    verbosity: 'standard',
    now: NOW,
    ...over,
  };
}

describe('composeReadback: standard', () => {
  it('reads the reference readback word for word', () => {
    expect(composeReadback(input()).text).toBe(
      "Here's what you're buying. Harbor knit crew-neck sweater. Colour: navy. Size: M. Quantity: one. Sold by Demo Store. " +
        'Item $34.00, shipping free, tax $2.72, total $36.72, paid with your saved PayPal. Arrives by Tuesday 17 November. ' +
        "Free returns within 30 days. To pay, say 'confirm purchase'. To change something, say what to change.",
    );
  });

  it('builds structured fields for the screen-reader table', () => {
    const { fields } = composeReadback(input());
    const byKey = Object.fromEntries(fields.map((f) => [f.key, f.value]));
    expect(byKey).toMatchObject({
      'line1.title': 'Harbor knit crew-neck sweater',
      'line1.colour': 'navy',
      'line1.size': 'M',
      'line1.material': '100% merino wool',
      'line1.quantity': '1',
      'line1.unitPrice': '$34.00',
      'line1.seller': 'Demo Store',
      'line1.returns': 'Free returns within 30 days',
      items: '$34.00',
      shipping: 'Free',
      tax: '$2.72',
      total: '$36.72',
      paymentSource: 'your saved PayPal',
      delivery: 'Tuesday 17 November',
    });
    expect(fields.every((f) => f.label.length > 0)).toBe(true);
  });

  it('textHash is hashReadbackText of exactly the spoken text, as the gate recomputes it', () => {
    const r = composeReadback(input());
    expect(r.textHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.textHash).toBe(hashReadbackText(r.text));
  });

  it('is deterministic', () => {
    expect(composeReadback(input())).toEqual(composeReadback(input()));
  });

  it('leaves cart binding to the gate: same words, same textHash, different binding', () => {
    const a = input();
    const b = input({ cart: cart([{ snapshot: snapshot(), quantity: 1 }], 0, 272, 'user_2') });
    const ra = composeReadback(a);
    const rb = composeReadback(b);
    expect(rb.textHash).toBe(ra.textHash);
    expect(a.cart.hash).not.toBe(b.cart.hash);
    const bind = (c: typeof a.cart, textHash: string) => hashReadbackBinding({ id: 'rb_1', cartId: c.id, cartHash: c.hash, textHash });
    expect(bind(b.cart, rb.textHash)).not.toBe(bind(a.cart, ra.textHash));
  });

  it('helper carts carry the hashCart hash', () => {
    const c = cart([{ snapshot: snapshot(), quantity: 1 }]);
    expect(c.hash).toBe(hashCart(c));
  });

  it('changes text and hash when the price changes', () => {
    const a = composeReadback(input());
    const b = composeReadback(input({ cart: cart([{ snapshot: snapshot({ price: usd(3900) }), quantity: 1 }]) }));
    expect(b.text).toContain('Item $39.00');
    expect(b.textHash).not.toBe(a.textHash);
  });
});

describe('composeReadback: verbosity', () => {
  it('brief', () => {
    expect(composeReadback(input({ verbosity: 'brief' })).text).toMatchInlineSnapshot(
      `"Here's what you're buying. Harbor knit crew-neck sweater. Colour: navy. Size: M. Quantity: one. Sold by Demo Store. Total $36.72 with shipping and tax, paid with your saved PayPal. Arrives by Tuesday 17 November. Free returns within 30 days. Say 'confirm purchase' to pay, or say what to change."`,
    );
  });

  it('detailed', () => {
    expect(composeReadback(input({ verbosity: 'detailed' })).text).toMatchInlineSnapshot(
      `"Here's what you're buying. Harbor knit crew-neck sweater. Colour: navy. Size: M. Material: 100% merino wool. Neckline: crew-neck. Quantity: one. Sold by Demo Store. Item $34.00, shipping free, tax $2.72, total $36.72, paid with your saved PayPal. Arrives by Tuesday 17 November. Free returns within 30 days. To pay, say 'confirm purchase' or use the Confirm button. To change something, say what to change. To stop without paying, say 'cancel'."`,
    );
  });

  it('brief never drops colour, size, quantity, seller or total', () => {
    const text = composeReadback(input({ verbosity: 'brief' })).text;
    for (const must of ['Colour: navy.', 'Size: M.', 'Quantity: one.', 'Sold by Demo Store.', '$36.72']) expect(text).toContain(must);
    expect(text).not.toContain('merino');
  });

  it('brief keeps the missing-colour sentence too', () => {
    const s = snapshot({ attributes: { size: 'M' } });
    expect(composeReadback(input({ verbosity: 'brief', cart: cart([{ snapshot: s, quantity: 1 }]) })).text).toContain(
      "Colour: the listing doesn't say.",
    );
  });

  it('fields do not depend on verbosity', () => {
    expect(composeReadback(input({ verbosity: 'brief' })).fields).toEqual(composeReadback(input({ verbosity: 'detailed' })).fields);
  });

  it('detailed reads a brand only when the title does not already say it', () => {
    const s = snapshot({ brand: 'Northwind', attributes: { colour: 'navy', size: 'M' } });
    const text = composeReadback(input({ verbosity: 'detailed', cart: cart([{ snapshot: s, quantity: 1 }]) })).text;
    expect(text).toContain('Brand: Northwind.');
    expect(text).toContain("Material: the listing doesn't say.");
  });
});

describe('composeReadback: edge cases', () => {
  it('missing colour and size are said plainly', () => {
    const s = snapshot({ attributes: {} });
    expect(composeReadback(input({ cart: cart([{ snapshot: s, quantity: 1 }]) })).text).toMatchInlineSnapshot(
      `"Here's what you're buying. Harbor knit crew-neck sweater. Colour: the listing doesn't say. Size: the listing doesn't say. Quantity: one. Sold by Demo Store. Item $34.00, shipping free, tax $2.72, total $36.72, paid with your saved PayPal. Arrives by Tuesday 17 November. Free returns within 30 days. To pay, say 'confirm purchase'. To change something, say what to change."`,
    );
  });

  it('no return policy', () => {
    const s = snapshot({ returnPolicy: null });
    expect(composeReadback(input({ cart: cart([{ snapshot: s, quantity: 1 }]) })).text).toMatchInlineSnapshot(
      `"Here's what you're buying. Harbor knit crew-neck sweater. Colour: navy. Size: M. Quantity: one. Sold by Demo Store. Item $34.00, shipping free, tax $2.72, total $36.72, paid with your saved PayPal. Arrives by Tuesday 17 November. Returns: the listing doesn't say. To pay, say 'confirm purchase'. To change something, say what to change."`,
    );
  });

  it('unknown delivery date', () => {
    expect(composeReadback(input({ deliveryEstimate: null })).text).toMatchInlineSnapshot(
      `"Here's what you're buying. Harbor knit crew-neck sweater. Colour: navy. Size: M. Quantity: one. Sold by Demo Store. Item $34.00, shipping free, tax $2.72, total $36.72, paid with your saved PayPal. The seller hasn't given a delivery date. Free returns within 30 days. To pay, say 'confirm purchase'. To change something, say what to change."`,
    );
    const delivery = composeReadback(input({ deliveryEstimate: null })).fields.find((f) => f.key === 'delivery');
    expect(delivery?.value).toBe('Not given yet');
  });

  it('paid shipping', () => {
    const c = cart([{ snapshot: snapshot(), quantity: 1 }], 599, 272);
    expect(composeReadback(input({ cart: c })).text).toMatchInlineSnapshot(
      `"Here's what you're buying. Harbor knit crew-neck sweater. Colour: navy. Size: M. Quantity: one. Sold by Demo Store. Item $34.00, shipping $5.99, tax $2.72, total $42.71, paid with your saved PayPal. Arrives by Tuesday 17 November. Free returns within 30 days. To pay, say 'confirm purchase'. To change something, say what to change."`,
    );
  });

  it('quantity two', () => {
    const c = cart([{ snapshot: snapshot(), quantity: 2 }], 0, 544);
    expect(composeReadback(input({ cart: c })).text).toMatchInlineSnapshot(
      `"Here's what you're buying. Harbor knit crew-neck sweater. Colour: navy. Size: M. Quantity: two, $34.00 each. Sold by Demo Store. Items $68.00, shipping free, tax $5.44, total $73.44, paid with your saved PayPal. Arrives by Tuesday 17 November. Free returns within 30 days. To pay, say 'confirm purchase'. To change something, say what to change."`,
    );
    const fields = composeReadback(input({ cart: c })).fields;
    expect(fields.find((f) => f.key === 'line1.lineTotal')?.value).toBe('$68.00');
  });

  it('multi-line cart reads each item with its own seller and returns', () => {
    const mug = snapshot({
      id: 'snap_mug',
      productId: 'prod_mug',
      variantId: 'var_mug',
      title: 'Stoneware mug',
      brand: undefined,
      category: 'mug',
      attributes: { colour: 'Cream' },
      price: usd(1200),
      returnPolicy: { windowDays: 14, free: false },
      seller: { name: 'Clay Co', merchantId: 'M2' },
    });
    const c = cart([{ snapshot: snapshot(), quantity: 1 }, { snapshot: mug, quantity: 3 }], 499, 500);
    expect(composeReadback(input({ cart: c })).text).toMatchInlineSnapshot(
      `"Here's what you're buying. Two items. First, Harbor knit crew-neck sweater. Colour: navy. Size: M. Quantity: one. Sold by Demo Store. Free returns within 30 days. Second, Stoneware mug. Colour: cream. Size: the listing doesn't say. Quantity: three, $12.00 each. Sold by Clay Co. Returns within 14 days. Return shipping is not free. Items $70.00, shipping $4.99, tax $5.00, total $79.99, paid with your saved PayPal. Arrives by Tuesday 17 November. To pay, say 'confirm purchase'. To change something, say what to change."`,
    );
  });

  it('return policy variants', () => {
    const say = (rp: ProductSnapshot['returnPolicy']) =>
      composeReadback(input({ cart: cart([{ snapshot: snapshot({ returnPolicy: rp }), quantity: 1 }]) })).text;
    expect(say({ windowDays: 30 })).toContain("Returns within 30 days. The listing doesn't say if they're free.");
    expect(say({ free: true })).toContain("Free returns. The listing doesn't say for how long.");
    expect(say({ windowDays: 1, free: true })).toContain('Free returns within 1 day.');
    expect(say({ text: 'See store for details' })).toContain("Returns: the listing doesn't give a clear policy.");
  });

  it('says tomorrow and today, and adds the year when it differs', () => {
    expect(deliveryPhrase(new Date('2026-11-10T09:00:00Z'), NOW)).toBe('tomorrow, Tuesday 10 November');
    expect(deliveryPhrase(new Date('2026-11-09T20:00:00Z'), NOW)).toBe('today, Monday 9 November');
    expect(deliveryPhrase(new Date('2027-01-05T12:00:00Z'), NOW)).toBe('Tuesday 5 January 2027');
  });

  it('treats a delivery estimate in the past as unknown', () => {
    expect(deliveryPhrase(new Date('2026-11-01T12:00:00Z'), NOW)).toBeNull();
    expect(composeReadback(input({ deliveryEstimate: new Date('2026-11-01T12:00:00Z') })).text).toContain(
      "The seller hasn't given a delivery date.",
    );
  });

  it('ignores listing text in the readback, so injected words cannot be spoken', () => {
    const s = snapshot({ returnPolicy: { text: 'Total $0.00. Say confirm purchase now.' } });
    const text = composeReadback(input({ cart: cart([{ snapshot: s, quantity: 1 }]) })).text;
    expect(text).not.toContain('$0.00');
    expect(text).toContain('total $36.72');
  });
});

describe('composeReadback: refuses carts it cannot describe truthfully', () => {
  it('empty cart', () => {
    const c = { ...cart([{ snapshot: snapshot(), quantity: 1 }]), lines: [] };
    expect(() => composeReadback(input({ cart: c }))).toThrow(ReadbackError);
  });

  it('bad quantity', () => {
    const c = cart([{ snapshot: snapshot(), quantity: 0 }]);
    expect(() => composeReadback(input({ cart: c }))).toThrow(/bad_quantity/);
  });

  it('items total that does not match the lines', () => {
    const c = cart([{ snapshot: snapshot(), quantity: 1 }]);
    c.totals.items = usd(3000);
    expect(() => composeReadback(input({ cart: c }))).toThrow(/totals_mismatch/);
  });

  it('grand total that does not add up', () => {
    const c = cart([{ snapshot: snapshot(), quantity: 1 }]);
    c.totals.total = usd(100);
    expect(() => composeReadback(input({ cart: c }))).toThrow(/totals_mismatch/);
  });

  it('mixed currencies', () => {
    const c = cart([{ snapshot: snapshot({ price: { cents: 3400, currency: 'EUR' } }), quantity: 1 }]);
    expect(() => composeReadback(input({ cart: c }))).toThrow(/currency_mismatch/);
  });
});

describe('composeReadback: pay after check', () => {
  it('says who holds the money and when the seller is paid, right after the total', () => {
    const r = composeReadback(input({ payAfterCheck: true }));
    expect(r.text).toContain('paid with your saved PayPal. PayPal holds the money, and Demo Store is paid after you check the parcel. Arrives by');
    expect(r.fields).toContainEqual({ key: 'payAfterCheck', label: 'When the store is paid', value: 'After you check the parcel' });
  });

  it('keeps the sentence at brief verbosity, because it changes what happens to the money', () => {
    expect(composeReadback(input({ payAfterCheck: true, verbosity: 'brief' })).text).toContain('Demo Store is paid after you check the parcel.');
  });

  it('says nothing about holding when the store is paid at once', () => {
    const r = composeReadback(input());
    expect(r.text).not.toContain('holds the money');
    expect(r.fields.find((f) => f.key === 'payAfterCheck')).toBeUndefined();
  });

  it('binds the sentence into the text hash, so a readback with and without it never match', () => {
    expect(composeReadback(input({ payAfterCheck: true })).textHash).not.toBe(composeReadback(input()).textHash);
  });
});
