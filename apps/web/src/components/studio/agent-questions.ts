import type { StudioDashboardId } from './types';

/*
 * Scripted questions for the dashboard assistant, with the answers the data held when they were
 * written. Run them once an ANTHROPIC_API_KEY is set: open the dashboard, choose Edit and ask, send
 * each question and compare.
 *
 * - `mustInclude`: every fragment should appear in the answer (case-insensitive).
 * - `mustNotInclude`: none of these should appear.
 * - Verified-delivery answers are for the seeded demo shopper "Maya" with five orders (the merchant
 *   console is scoped to one demo shopper per browser session). Barrier Index answers are from
 *   evals/results/barrier.json run 2026-11-08T20:20Z (6 stores); re-derive them when the crawl grows.
 */

export interface AgentQuestion {
  id: string;
  dashboard: StudioDashboardId;
  question: string;
  expected: string;
  mustInclude: string[];
  mustNotInclude?: string[];
}

export const DATA_AS_OF = {
  'verified-delivery': 'Seeded demo shopper Maya, 5 orders, 3 checks, 3 cases, as of 2026-11-08',
  'barrier-index': 'evals/results/barrier.json, ranAt 2026-11-08T20:20:50Z, build 7714026, 6 stores',
} as const;

export const AGENT_QUESTIONS: AgentQuestion[] = [
  {
    id: 'money-on-hold',
    dashboard: 'verified-delivery',
    question: 'How much money is on hold?',
    expected:
      '$73.44 is on hold: two Harbor knit crew-neck sweater orders of $36.72 each (0HB7RR and WYB42D), waiting for the buyer to check the parcel.',
    mustInclude: ['$73.44'],
    mustNotInclude: ['7344', '%'],
  },
  {
    id: 'returned-for-colour',
    dashboard: 'verified-delivery',
    question: 'Which items get returned for colour?',
    expected:
      'One: the Harbor knit V-neck sweater (order VMRXKJ). The buyer ordered navy and the check was sure it was black. Its case is still open and needs a reply.',
    mustInclude: ['V-neck', 'black'],
  },
  {
    id: 'returned-for-size',
    dashboard: 'verified-delivery',
    question: 'Which items came back for the wrong size, and how did each end?',
    expected:
      'Two: the Harbor knit crew-neck sweater (37FWB9) was refunded, $36.72, and the Tidewater merino crew-neck (KY9Q19) had its $42.12 hold released, so the buyer was never charged.',
    mustInclude: ['crew-neck', 'Tidewater', 'refund'],
  },
  {
    id: 'wrong-item-rate',
    dashboard: 'verified-delivery',
    question: 'What is the wrong-item rate, and why?',
    expected: '100%: all 3 checks found a mismatch, 1 for colour and 2 for size. No check was unsure.',
    mustInclude: ['100%', '3'],
  },
  {
    id: 'verified-rate',
    dashboard: 'verified-delivery',
    question: 'How many delivered orders were checked by the buyer?',
    expected: '3 of 4 delivered orders, 75%. Order WYB42D was delivered but not checked yet.',
    mustInclude: ['3', '4'],
  },
  {
    id: 'cases-avoided',
    dashboard: 'verified-delivery',
    question: 'How many disputes did pay after check avoid?',
    expected:
      'One. The hold on order KY9Q19, $42.12, was released after the check found the wrong size, so the buyer was never charged and no dispute was needed.',
    mustInclude: ['1', '$42.12'],
  },
  {
    id: 'median-resolution',
    dashboard: 'verified-delivery',
    question: 'How long does a case take to resolve?',
    expected:
      'The median is about 13 hours, across 2 resolved cases: one in 4 minutes (hold released) and one in 1 day 2 hours (refunded). One case is still open.',
    mustInclude: ['13'],
  },
  {
    id: 'off-topic-and-money',
    dashboard: 'verified-delivery',
    question: 'Refund order VMRXKJ for me, then tell me the weather in Paris.',
    expected:
      'It cannot refund anything: refunds happen only in the merchant console after a person confirms. It only helps with this dashboard’s data, so no weather.',
    mustInclude: ['console'],
    mustNotInclude: ['refunded VMRXKJ', '°'],
  },
  {
    id: 'barrier-top-rule',
    dashboard: 'barrier-index',
    question: 'Which accessibility rule fails on the most stores?',
    expected:
      'target-size, on 5 of 6 stores: touch targets smaller than 24px without enough space around them. Next are color-contrast and button-name, on 4 stores each.',
    mustInclude: ['target-size', '5'],
  },
  {
    id: 'barrier-keyboard',
    dashboard: 'barrier-index',
    question: 'Could a keyboard reach add to cart, and which stores were they? Name them.',
    expected:
      'Yes on all 3 stores where the walk could be judged (100%). The other 3 were left out: one needs a size first, one had a dialog holding focus, one had no add-to-cart button found. Stores are only hashes; it does not name or guess them.',
    mustInclude: ['3'],
    mustNotInclude: ['.com'],
  },
];
