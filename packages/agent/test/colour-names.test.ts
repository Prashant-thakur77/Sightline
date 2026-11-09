import { describe, expect, it } from 'vitest';
import { composeReadback } from '../src/readback';
import { presentDetails, presentOptions } from '../src/present';
import { cart, NOW, SAVED_PAYPAL, snapshot, TUE_17_NOV } from './helpers';

const inTheNavy = snapshot({ attributes: { colour: 'navy', colourName: 'In The Navy', size: 'M' } });
const abalone = snapshot({ id: 'snap_abalone', attributes: { colourName: 'Abalone', size: 'M' } });

const read = (s: typeof inTheNavy) =>
  composeReadback({ cart: cart([{ snapshot: s, quantity: 1 }]), paymentSource: SAVED_PAYPAL, deliveryEstimate: TUE_17_NOV, locale: 'en-US', verbosity: 'standard', now: NOW });

describe('a store’s colour name is never spoken as the colour', () => {
  it('readback: the plain colour, with the store’s name beside it', () => {
    const r = read(inTheNavy);
    expect(r.text).toContain('Colour: navy, listed as “In The Navy”.');
    expect(r.text).not.toMatch(/Colour: in the navy/i);
    expect(r.fields.find((f) => f.key.endsWith('colour'))?.value).toBe('navy, listed as “In The Navy”');
  });

  it('readback: a name with no colour in it is only the listing’s words', () => {
    expect(read(abalone).text).toContain('Colour: the listing calls it “Abalone”.');
  });

  it('details and options say it the same way', () => {
    expect(presentDetails(inTheNavy, 'colour').text).toBe('The colour is navy. The listing calls it “In The Navy”.');
    expect(presentDetails(abalone, 'colour').text).toBe('The listing doesn\'t give a plain colour. It calls the colour “Abalone”.');
    const p = presentOptions({ options: [{ rank: 1, snapshot: abalone, score: 1, why: [], caveats: [], verifiable: false, missing: ['colour'] }], remaining: 0 });
    expect(p.sentences[1]).toContain('the listing calls it “Abalone”');
  });
});
