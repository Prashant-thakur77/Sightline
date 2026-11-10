/**
 * Held-out split for the grounding guard. Written and committed before the date, negation and
 * citation checks were built, and never used to tune them: the guard is developed against the
 * development split (answers.ts and the unit tests) and scored on this set once.
 *
 * 72 single-segment answers over the Demo Store products, in three groups of 24 (half true, half
 * not supported by the listing):
 *   delivery_date  dates in spoken and written forms, checked against the store's estimate with a
 *                  clock that differs from the development split's (Thursday 12 November 2026,
 *                  09:00 UTC, so the estimate is Tuesday 17 November)
 *   negation       negated statements: false ones contradict the listing, true ones deny
 *                  something the listing rules out
 *   citation       quotes and cited fields: quotes that are not verbatim, review claims with no
 *                  quote, features the cited field does not state, and their true counterparts
 *
 * Labels say whether the listing (or the store's delivery estimate) supports the sentence as
 * spoken. They were set from the listing data, not from what any guard does.
 */
import type { Claim, Segment } from '@sightline/agent';
import { deliveryEstimate } from '@sightline/catalog';

export const HELDOUT_NOW = new Date('2026-11-12T09:00:00.000Z');
export const HELDOUT_ESTIMATE = deliveryEstimate(HELDOUT_NOW);

export type HeldoutGroup = 'delivery_date' | 'negation' | 'citation';

export interface HeldoutCase {
  id: string;
  group: HeldoutGroup;
  slug: string;
  colour: string;
  segment: Segment;
  /** True when the listing does not support the sentence. */
  hasUnsupported: boolean;
}

const field = (ref: string): Claim => ({ kind: 'field', ref });
const quote = (q: string, sourceId: string): Claim => ({ kind: 'quote', quote: q, sourceId });

/** Cases; `reviews` is the source id the runner gives the product's review quotes. */
export function heldoutCases(reviews: string): HeldoutCase[] {
  const out: HeldoutCase[] = [];
  const add = (
    id: string,
    group: HeldoutGroup,
    slug: string,
    colour: string,
    text: string,
    claims: Claim[],
    hasUnsupported: boolean,
  ) => out.push({ id, group, slug, colour, segment: { text, claims }, hasUnsupported });
  const d = (id: string, slug: string, colour: string, text: string, bad: boolean) =>
    add(id, 'delivery_date', slug, colour, text, [field('delivery.estimate')], bad);

  // Delivery, true: the estimate is Tuesday 17 November.
  d('d-s1', 'harbor-knit-crew', 'navy', 'It should arrive on Tuesday.', false);
  d('d-s2', 'mill-cotton-tee', 'white', 'Expect it next Tuesday.', false);
  d('d-s3', 'stoneware-mug', 'cream', 'It arrives Nov 17.', false);
  d('d-s4', 'canvas-tote', 'natural', 'Delivery is due on the 17th.', false);
  d('d-s5', 'trail-runner-2', 'black', 'It will be with you in 5 days.', false);
  d('d-s6', 'braided-usb-c-cable', 'black', 'It gets there in three business days.', false);
  d('d-s7', 'wall-charger-30w', 'white', 'It arrives early next week.', false);
  d('d-s8', 'tidewater-merino-crew', 'navy', "You'll have it on Tuesday the seventeenth.", false);
  d('d-s9', 'harbor-knit-vneck', 'olive', 'It should be delivered by 17 Nov.', false);
  d('d-s10', 'everyday-cable-crew', 'cream', 'Delivery is expected November 17th.', false);
  d('d-s11', 'mill-cotton-tee', 'navy', 'It arrives next week.', false);
  d('d-s12', 'harbor-knit-crew', 'black', 'It lands Tuesday, November 17.', false);

  // Delivery, invented.
  d('d-u1', 'harbor-knit-crew', 'navy', 'It arrives tomorrow.', true);
  d('d-u2', 'mill-cotton-tee', 'white', 'It should arrive by Friday.', true);
  d('d-u3', 'stoneware-mug', 'teal', "You'll get it this weekend.", true);
  d('d-u4', 'canvas-tote', 'navy', 'It arrives by Monday.', true);
  d('d-u5', 'trail-runner-2', 'royal blue', 'Expect it next Wednesday.', true);
  d('d-u6', 'braided-usb-c-cable', 'black', 'It arrives Nov 20.', true);
  d('d-u7', 'wall-charger-30w', 'white', 'Delivery is due on the 19th.', true);
  d('d-u8', 'tidewater-merino-crew', 'charcoal', 'It will be with you in two days.', true);
  d('d-u9', 'harbor-knit-vneck', 'navy', 'It ships today and arrives Saturday.', true);
  d('d-u10', 'everyday-cable-crew', 'navy', "It's due Wednesday the 18th.", true);
  d('d-u11', 'mill-cotton-tee', 'black', 'It will arrive the day after tomorrow.', true);
  d('d-u12', 'harbor-knit-crew', 'heather grey', 'It arrives within 3 days.', true);

  const n = (id: string, slug: string, colour: string, text: string, ref: string, bad: boolean) =>
    add(id, 'negation', slug, colour, text, [field(ref)], bad);

  // Negation, false: the listing says the opposite.
  n('n-u1', 'mill-cotton-tee', 'white', "It isn't organic.", 'attributes.material', true);
  n('n-u2', 'harbor-knit-crew', 'navy', 'It is not machine washable.', 'description', true);
  n('n-u3', 'tidewater-merino-crew', 'navy', "There's no return fee.", 'returnPolicy', true);
  n(
    'n-u4',
    'trail-runner-2',
    'black',
    "You can't return them once they've been worn outdoors.",
    'returnPolicy',
    true,
  );
  n('n-u5', 'stoneware-mug', 'cream', "It isn't dishwasher safe.", 'attributes.care', true);
  n('n-u6', 'canvas-tote', 'natural', "It's not made of cotton.", 'attributes.material', true);
  n('n-u7', 'braided-usb-c-cable', 'black', "It doesn't carry 60 watts.", 'attributes.wattage', true);
  n('n-u8', 'harbor-knit-vneck', 'olive', "Returns aren't free.", 'returnPolicy', true);
  n('n-u9', 'wall-charger-30w', 'white', "It doesn't come with a US plug.", 'attributes.plug', true);
  n('n-u10', 'mill-cotton-tee', 'black', 'There are no returns on this one.', 'returnPolicy', true);
  n('n-u11', 'harbor-knit-crew', 'black', "There's no recycled material in it.", 'attributes.material', true);
  n('n-u12', 'tidewater-merino-crew', 'navy', 'This one is not navy.', 'attributes.colour', true);

  // Negation, true: the listing rules the denied thing out.
  n('n-s1', 'mill-cotton-tee', 'white', "It isn't wool.", 'attributes.material', false);
  n(
    'n-s2',
    'stoneware-mug',
    'teal',
    "Returns aren't free; you pay the return shipping.",
    'returnPolicy',
    false,
  );
  n('n-s3', 'tidewater-merino-crew', 'charcoal', 'Returns are not free.', 'returnPolicy', false);
  n('n-s4', 'harbor-knit-crew', 'heather grey', "It isn't merino.", 'attributes.material', false);
  n(
    'n-s5',
    'tidewater-merino-crew',
    'burgundy',
    "It doesn't contain any cotton.",
    'attributes.material',
    false,
  );
  n(
    'n-s6',
    'wall-charger-30w',
    'white',
    "It isn't a 60 watt charger; it's 30 watts.",
    'attributes.wattage',
    false,
  );
  n(
    'n-s7',
    'braided-usb-c-cable',
    'black',
    "It's not 1 metre long, it's 2 metres.",
    'attributes.length',
    false,
  );
  n(
    'n-s8',
    'stoneware-mug',
    'cream',
    "It doesn't hold 16 ounces; it holds 12.",
    'attributes.capacity',
    false,
  );
  n('n-s9', 'harbor-knit-crew', 'navy', "This one isn't black.", 'attributes.colour', false);
  n('n-s10', 'canvas-tote', 'natural', "It isn't leather.", 'attributes.material', false);
  add(
    'n-s11',
    'negation',
    'harbor-knit-crew',
    'navy',
    'A reviewer says it is "not itchy at all".',
    [quote('Soft and not itchy at all.', reviews)],
    false,
  );
  n('n-s12', 'mill-cotton-tee', 'forest green', "It isn't a slim fit; it's boxy.", 'attributes.fit', false);

  const c = (id: string, slug: string, colour: string, text: string, claims: Claim[], bad: boolean) =>
    add(id, 'citation', slug, colour, text, claims, bad);

  // Citation, unsupported: the quote is not verbatim, no quote backs a review claim, or the cited
  // field does not state the feature.
  c('c-u1', 'harbor-knit-crew', 'navy', 'Reviewers say it keeps you very warm.', [], true);
  c(
    'c-u2',
    'harbor-knit-crew',
    'black',
    'One reviewer wrote "fits perfectly."',
    [quote('fits perfectly.', reviews)],
    true,
  );
  c(
    'c-u3',
    'harbor-knit-crew',
    'navy',
    'A reviewer said "Lovely wool, very warm for how thin it is."',
    [quote('Lovely wool, very warm for how thin it is.', reviews)],
    true,
  );
  c(
    'c-u4',
    'mill-cotton-tee',
    'white',
    'A reviewer wrote that it "runs small".',
    [quote('runs small', reviews)],
    true,
  );
  c('c-u5', 'tidewater-merino-crew', 'navy', "It's machine washable.", [field('attributes.care')], true);
  c('c-u6', 'trail-runner-2', 'black', "They're waterproof.", [field('description')], true);
  c(
    'c-u7',
    'harbor-knit-crew',
    'heather grey',
    'Reviewers wrote "Soft and true to size."',
    [quote('Soft and true to size.', reviews)],
    true,
  );
  c('c-u8', 'canvas-tote', 'navy', 'The tote is water resistant.', [field('attributes.material')], true);

  // Citation, supported.
  c(
    'c-s1',
    'harbor-knit-crew',
    'navy',
    'A reviewer wrote "runs TRUE to size.  I am usually a medium"',
    [quote('Runs true to size. I am usually a medium', reviews)],
    false,
  );
  c('c-s2', 'harbor-knit-crew', 'black', "It's machine washable.", [field('description')], false);
  c(
    'c-s3',
    'mill-cotton-tee',
    'white',
    'One reviewer says "Boxy and a little short."',
    [quote('Boxy and a little short', reviews)],
    false,
  );
  c(
    'c-s4',
    'harbor-knit-vneck',
    'navy',
    'The care label says machine wash cold.',
    [field('attributes.care')],
    false,
  );
  c('c-s5', 'stoneware-mug', 'teal', "It's dishwasher and microwave safe.", [field('description')], false);
  c(
    'c-s6',
    'tidewater-merino-crew',
    'burgundy',
    "It's hand wash or dry clean.",
    [field('description')],
    false,
  );
  c(
    'c-s7',
    'harbor-knit-vneck',
    'olive',
    "It's made with recycled polyester.",
    [field('attributes.material')],
    false,
  );
  c(
    'c-s8',
    'tidewater-merino-crew',
    'navy',
    'A reviewer wrote "Slim through the body, size up if you are between sizes."',
    [quote('Slim through the body, size up if you are between sizes.', reviews)],
    false,
  );

  return out;
}
