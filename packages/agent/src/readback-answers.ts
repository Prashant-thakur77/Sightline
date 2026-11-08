/**
 * Questions asked while a readback is waiting for a confirmation ("what's the total?", "what size
 * is it?", "when does it arrive?") are answered from the readback's own fields, then the buyer
 * hears again how to pay. Nothing here comes from the model or from the live listing: the answer
 * is always what the readback said.
 */
import type { ReadbackField, Verbosity } from '@sightline/core';
import { en } from './copy/en';
import { COLOURS, SIZE_WORDS, findPhrases } from './lexicon';
import { expandContractions, words } from './text';

export type ReadbackTopic =
  | 'all'
  | 'total'
  | 'unit_price'
  | 'shipping'
  | 'tax'
  | 'delivery'
  | 'store_paid'
  | 'payment'
  | 'size'
  | 'colour'
  | 'material'
  | 'seller'
  | 'quantity'
  | 'returns'
  | 'item';

export interface ReadbackAnswer {
  topic: ReadbackTopic;
  text: string;
}

const QUESTIONISH = /^(what|whats|how|is|does|do|can|could|who|which|when|where|will|tell|say|read|are|and)\b/;

/** Topic rules, most specific first. Each pattern runs on the cleaned words joined by spaces. */
const TOPICS: Array<[ReadbackTopic, RegExp]> = [
  ['all', /^(read (it|that|the order|the readback|it all) again|tell me more|more details|details|what is in (my|the) (cart|order)|read the (order|readback)|go over it again)$/],
  ['store_paid', /\b(when (is|does|will) (the store|the seller|demo store|it|the shop) (get )?paid|when is the store paid|when do they get paid|pay after (the )?check)\b/],
  ['payment', /\b(paid with|paying with|pay with|which paypal|what paypal|which account|what account|which card|what card|payment method|how am i paying|how do i pay for it)\b/],
  ['tax', /\btax(es)?\b/],
  ['delivery', /\b(arrive|arrives|arriving|arrival|deliver|delivered|delivery|get here|come|comes|coming|ship|ships|shipped|how long)\b/],
  ['shipping', /\b(shipping|postage)\b/],
  ['unit_price', /\b(each|per item|unit price|price each|one of them)\b/],
  ['total', /\b(total|how much|cost|costs|price|pay|paying|charge|charged|owe|amount|spend|spending)\b/],
  ['quantity', /\b(how many|quantity)\b/],
  ['size', /\bsize\b/],
  ['colour', /\b(colou?r|shade)\b/],
  ['material', /\b(material|made of|made from|fabric)\b/],
  ['seller', /\b(who sells|seller|sold by|which store|what store|who is selling|merchant|buying from|from who|from whom|which shop|what shop)\b/],
  ['returns', /\b(return|returns|returnable|refund|send it back)\b/],
  ['item', /\b(what am i buying|what is it|which item|what item|what product|which product|which one)\b/],
];

type LabelKey = keyof typeof en.readback.labels;

/** Per-item topics: the field key after "lineN." and the label used when the field is missing. */
const LINE_KEYS: Partial<Record<ReadbackTopic, { key: string; label: LabelKey }>> = {
  size: { key: 'size', label: 'size' },
  colour: { key: 'colour', label: 'colour' },
  material: { key: 'material', label: 'material' },
  seller: { key: 'seller', label: 'seller' },
  quantity: { key: 'quantity', label: 'quantity' },
  returns: { key: 'returns', label: 'returns' },
  item: { key: 'title', label: 'item' },
  unit_price: { key: 'unitPrice', label: 'unitPrice' },
};

const LEADING_FILLERS = new Set(['um', 'umm', 'uh', 'er', 'erm', 'okay', 'ok', 'so', 'well', 'sorry', 'hey', 'oh']);

const ORDER_KEYS: Partial<Record<ReadbackTopic, string>> = {
  total: 'total',
  shipping: 'shipping',
  tax: 'tax',
  payment: 'paymentSource',
  delivery: 'delivery',
  store_paid: 'payAfterCheck',
};

function topicOf(s: string, ws: string[]): ReadbackTopic | null {
  for (const [topic, re] of TOPICS) if (re.test(s)) return topic;
  // "is it medium?", "is it navy?"
  if (findPhrases(ws, SIZE_WORDS).length > 0 && QUESTIONISH.test(s)) return 'size';
  if (findPhrases(ws, COLOURS).length > 0 && QUESTIONISH.test(s)) return 'colour';
  return null;
}

function closing(verbosity: Verbosity): string {
  if (verbosity === 'brief') return en.readback.closingBrief;
  if (verbosity === 'detailed') return en.readback.closingDetailed;
  return en.readback.closingStandard;
}

/**
 * The answer, or null when the utterance is not a question about the readback (a change such as
 * "make it a large" or a confirmation is never answered here). Only short utterances or ones that
 * sound like questions are considered.
 */
export function answerReadbackQuestion(input: {
  utterance: string;
  fields: ReadbackField[];
  /** The readback as spoken; "read it again" answers with it. */
  text: string;
  verbosity?: Verbosity;
}): ReadbackAnswer | null {
  const raw = input.utterance.trim();
  const all = expandContractions(words(raw));
  let start = 0;
  while (start < all.length && LEADING_FILLERS.has(all[start]!)) start++;
  const ws = all.slice(start).filter((w) => w !== 'please');
  if (ws.length === 0) return null;
  const s = ws.join(' ');
  const questionLike = raw.includes('?') || QUESTIONISH.test(s) || ws.length <= 3;
  if (!questionLike) return null;
  const topic = topicOf(s, ws);
  if (!topic) return null;
  if (topic === 'all') return { topic, text: input.text };

  const fields = input.fields;
  const A = en.readback.answers;
  let answer: string;
  const line = LINE_KEYS[topic];
  if (line) {
    const hits = fields.filter((f) => new RegExp(`^line\\d+\\.${line.key}$`).test(f.key));
    if (hits.length === 0) {
      answer = A.field(en.readback.labels[line.label], en.readback.missing);
    } else if (hits.length === 1) {
      const f = hits[0]!;
      answer = topic === 'seller' ? A.soldBy(f.value) : A.field(f.label, f.value);
    } else {
      answer = hits
        .map((f, i) => A.lineField(en.readback.ordinals[i] ?? en.readback.itemN(i + 1), f.label, f.value))
        .join(' ');
    }
  } else {
    const key = ORDER_KEYS[topic]!;
    const f = fields.find((x) => x.key === key);
    if (topic === 'total') answer = A.total(f?.value ?? en.readback.missing);
    else if (topic === 'delivery')
      answer = f && f.value !== en.readback.labels.notGivenYet ? A.delivery(f.value) : en.readback.deliveryUnknown;
    else if (topic === 'store_paid') answer = f ? A.field(f.label, f.value) : A.storePaidNow;
    else answer = A.field(f?.label ?? en.readback.labels[topic === 'payment' ? 'paymentSource' : (topic as 'tax' | 'shipping')], f?.value ?? en.readback.missing);
  }
  return { topic, text: `${answer} ${closing(input.verbosity ?? 'standard')}` };
}
