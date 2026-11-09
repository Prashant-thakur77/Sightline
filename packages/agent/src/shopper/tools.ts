/**
 * The shopping agent's tools: their definitions for the model (strict JSON schemas), and the zod
 * schemas every call is checked against before it runs. All tools are read-only except memory,
 * and memory only proposes: the app asks the buyer before saving anything. No tool can set a
 * price, a total, a payee or a confirmation.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { MEMORY_KINDS } from '../memory';
import { MONEY_PERIODS, MONEY_QUESTIONS } from '../money';

/** Tools that end the turn. Everything else gathers facts and the loop goes on. */
export const TERMINAL_TOOLS = new Set([
  'ask_clarifying_question',
  'present_options',
  'answer_about_products',
  'start_readback',
  'recall_preferences',
  'money_question',
]);

const obj = (properties: Record<string, unknown>, required: string[]): Anthropic.Tool.InputSchema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

const str = (description: string) => ({ type: 'string', description });

export const SHOPPER_TOOLS: Anthropic.Tool[] = [
  {
    name: 'search_products',
    description:
      'Search the store catalog for listings. Call it for any request to find or suggest something, before presenting options. ' +
      'Use short catalog wording, 2 to 5 words, the way a product title says it ("merino hiking socks", "soft cotton sweater"), not the buyer\'s sentence. ' +
      'For a vague or gift request, call it two or three times in the same turn with different phrasings. Filters are applied in code. ' +
      'Results come back ranked best first, each with an id (p1, p2, ...) to use with the other tools. Results never include fan or team merchandise unless asked for.',
    strict: true,
    input_schema: obj(
      {
        query: str('2 to 5 catalog words.'),
        category: str('One kind of product when it is clear: sweater, cardigan, hoodie, t-shirt, jacket, socks, hat, scarf, gloves, backpack, mug, running shoes, and so on.'),
        colour: str('A colour the buyer asked for.'),
        size: str("A size the buyer said for this item. Leave it out unless the buyer said it; saved sizes are added in code."),
        max_price_dollars: { type: 'number', description: 'A budget the buyer said, in dollars.' },
        min_price_dollars: { type: 'number', description: 'A lowest price the buyer said, in dollars.' },
        for_someone_else: { type: 'boolean', description: "True for a gift or anything for another person: the buyer's own saved sizes and likes are then not used." },
        avoid_materials: { type: 'array', items: { type: 'string' }, description: 'Materials to leave out for this search, for example ["wool"] for "not scratchy".' },
      },
      ['query', 'for_someone_else'],
    ),
  },
  {
    name: 'get_product_details',
    description: 'Read everything a listing says: description, material, fit, care, sizes, rating and review quotes. Use it before answering a question about one listing.',
    strict: true,
    input_schema: obj({ id: str('A product id from search results (p1), the options on screen (o1), or order history (h1).') }, ['id']),
  },
  {
    name: 'compare_products',
    description: 'Compare two or three listings side by side from their listing data (price, colour, size, material, returns, rating).',
    strict: true,
    input_schema: obj({ ids: { type: 'array', items: { type: 'string' }, description: 'Two or three product ids.' }, aspect: str('What to compare on, if the buyer said: price, material, warmth, returns, rating.') }, ['ids']),
  },
  {
    name: 'get_order_history',
    description: 'The buyer\'s past orders, most often and most recently bought first, each with an id (h1, h2, ...). Use it for "my usual", "the same again" or "what I bought last time".',
    strict: true,
    input_schema: obj({}, []),
  },
  {
    name: 'ask_clarifying_question',
    description: 'Ends the turn with one short spoken question, when the request is too vague to search well (for example "a gift" with no clue at all). Do not ask when you can reasonably search.',
    strict: true,
    input_schema: obj({ question: str('One short question, under 20 words, ending with a question mark.') }, ['question']),
  },
  {
    name: 'present_options',
    description:
      'Ends the turn by reading up to three listings to the buyer, best first. The app reads each one\'s title, colour, size, price, rating and returns itself; ' +
      'you add one short reason per option (under 12 words) saying why it suits this request, from the listing facts in the tool results, without repeating those. Never state prices, totals or delivery dates.',
    strict: true,
    input_schema: obj(
      {
        options: {
          type: 'array',
          items: obj({ id: str('A product id from the results.'), reason: str('Why it suits this request, under 12 words, from listing facts; not the colour, size, price, rating or returns.') }, ['id', 'reason']),
          description: 'One to three options.',
        },
        lead: str('Optional opening line under 12 words, for example "Here are warm picks for a hiker."'),
      },
      ['options'],
    ),
  },
  {
    name: 'answer_about_products',
    description:
      'Ends the turn with a short spoken answer to a question about listings. Each sentence lists the product ids its facts come from. ' +
      'Use only what the listings say; if they don\'t say, the sentence is "The listings don\'t say." with no ids.',
    strict: true,
    input_schema: obj(
      {
        sentences: {
          type: 'array',
          items: obj({ text: str('One short sentence.'), product_ids: { type: 'array', items: { type: 'string' } } }, ['text', 'product_ids']),
        },
      },
      ['sentences'],
    ),
  },
  {
    name: 'start_readback',
    description:
      'Ends the turn by reading one listing back as an order, only when the buyer clearly asked to buy a specific item. Pass the size the buyer chose, if any. ' +
      'This only reads the order back. Paying needs the buyer\'s own spoken confirmation afterwards, which you never give.',
    strict: true,
    input_schema: obj({ id: str('The product id to buy.'), size: str('The size the buyer chose, if any.') }, ['id']),
  },
  {
    name: 'remember_preference',
    description:
      'Proposes remembering a lasting preference the buyer stated about themselves: their size in a kind of clothing, a material or colour they avoid or like, or their usual budget. ' +
      'The app asks the buyer before saving it. Do not use it for one-off wishes or for gifts.',
    strict: true,
    input_schema: obj(
      {
        kind: { type: 'string', enum: [...MEMORY_KINDS] },
        value: str('The size, material, colour, or budget in dollars, exactly as the buyer said it.'),
        category: str('For a size or budget: the kind of clothing it is for, if the buyer said.'),
      },
      ['kind', 'value'],
    ),
  },
  {
    name: 'recall_preferences',
    description: 'Ends the turn by telling the buyer what the app remembers about them. Use it when they ask what you remember or know about them.',
    strict: true,
    input_schema: obj({}, []),
  },
  {
    name: 'money_question',
    description:
      'Ends the turn with the answer to a question about the buyer\'s own orders and money, which the app computes from its records: ' +
      'on_hold (what is on hold), spent (how much was paid), hold_ends (when a hold ends), refunds, orders (what was ordered), overview (where the money is).',
    strict: true,
    input_schema: obj(
      { question: { type: 'string', enum: [...MONEY_QUESTIONS] }, period: { type: 'string', enum: [...MONEY_PERIODS], description: 'The time the buyer named, if any.' } },
      ['question'],
    ),
  },
];

// Every call is checked again here: an input that doesn't fit is never run.
export const ToolInputs = {
  search_products: z.object({
    query: z.string().min(1).max(80),
    category: z.string().max(40).optional(),
    colour: z.string().max(40).optional(),
    size: z.string().max(12).optional(),
    max_price_dollars: z.number().positive().max(100000).optional(),
    min_price_dollars: z.number().nonnegative().max(100000).optional(),
    for_someone_else: z.boolean(),
    avoid_materials: z.array(z.string().max(30)).max(5).optional(),
  }),
  get_product_details: z.object({ id: z.string().max(8) }),
  compare_products: z.object({ ids: z.array(z.string().max(8)).min(2).max(3), aspect: z.string().max(30).optional() }),
  get_order_history: z.object({}),
  ask_clarifying_question: z.object({ question: z.string().min(3).max(200) }),
  present_options: z.object({
    options: z.array(z.object({ id: z.string().max(8), reason: z.string().max(200) })).min(1).max(3),
    lead: z.string().max(140).optional(),
  }),
  answer_about_products: z.object({ sentences: z.array(z.object({ text: z.string().min(1).max(240), product_ids: z.array(z.string().max(8)).max(3) })).min(1).max(4) }),
  start_readback: z.object({ id: z.string().max(8), size: z.string().max(12).optional() }),
  remember_preference: z.object({ kind: z.enum(MEMORY_KINDS as [string, ...string[]]), value: z.string().min(1).max(40), category: z.string().max(40).optional() }),
  recall_preferences: z.object({}),
  money_question: z.object({ question: z.enum(MONEY_QUESTIONS as [string, ...string[]]), period: z.enum(MONEY_PERIODS as [string, ...string[]]).optional() }),
} as const;

export type ToolName = keyof typeof ToolInputs;
