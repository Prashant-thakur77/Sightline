import { askedConflicts, buyerAsked, compareAsked } from '@sightline/agent/asked';
import { fail, pass } from '../guard';
import type { Guard, GuardContext, GuardResult } from '../types';

/** At most this many buyer utterances are read; the newest are kept. */
export const MAX_BUYER_UTTERANCES = 200;

/**
 * The cart variant must be what the buyer asked for. The buyer's own utterances in this
 * conversation (never model text) are parsed by the grammar into the colour, size and material
 * they stated, latest statement winning, and compared with each cart line's listing snapshot.
 * A conflict refuses even a confirmed readback: "navy" was asked for, the cart is charcoal.
 * An attribute the buyer never stated, or the listing does not state, is not compared.
 */
export class IntentGuard implements Guard {
  readonly name = 'IntentGuard';

  async run({ intent }: GuardContext): Promise<GuardResult> {
    const raw = Array.isArray(intent.buyerUtterances) ? intent.buyerUtterances : [];
    const utterances = raw
      .filter((u) => u && typeof u.text === 'string')
      .slice(-MAX_BUYER_UTTERANCES)
      .map((u) => ({ text: u.text, ...(typeof u.at === 'string' ? { at: u.at } : {}) }));
    const asked = buyerAsked(utterances);
    const stated = Object.keys(asked);
    if (stated.length === 0) {
      return pass(this.name, 'The buyer stated no colour, size or material to compare', { utterancesRead: utterances.length, asked: {} });
    }
    const lines = intent.cart.lines.map((l, i) => {
      const attrs = l.snapshot?.attributes ?? {};
      const comparisons = compareAsked(asked, attrs);
      const conflicts = askedConflicts(asked, attrs).map((c) => ({ attribute: c.attribute, asked: c.asked.value, cart: c.cart, utterance: c.asked.utterance }));
      return { line: i + 1, snapshotId: String(l.snapshot?.id), comparisons, conflicts };
    });
    const askedSummary = Object.fromEntries(Object.entries(asked).map(([k, v]) => [k, { value: v!.value, utterance: v!.utterance }]));
    const conflicts = lines.flatMap((l) => l.conflicts.map((c) => ({ line: l.line, ...c })));
    if (conflicts.length > 0) {
      return fail(this.name, 'INTENT_MISMATCH', 'The cart variant is not what the buyer asked for', {
        utterancesRead: utterances.length,
        asked: askedSummary,
        conflicts,
        lines: lines.map(({ line, snapshotId, comparisons }) => ({ line, snapshotId, comparisons })),
      });
    }
    return pass(this.name, 'The cart variant matches what the buyer asked for', {
      utterancesRead: utterances.length,
      asked: askedSummary,
      lines: lines.map(({ line, snapshotId, comparisons }) => ({ line, snapshotId, comparisons })),
    });
  }
}
