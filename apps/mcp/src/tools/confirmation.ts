import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { en, matchConfirmationPhrase, type PhraseDecision, type PhraseReason } from '@sightline/agent';
import { z } from 'zod';
import { ok } from '../shared';

export const confirmationInput = {
  utterance: z
    .string()
    .max(500)
    .describe('What the user said or typed, exactly as heard. Do not clean it up or summarise it.'),
  phase: z
    .enum(['readback', 'offer'])
    .default('readback')
    .describe(
      "'readback' when confirming a purchase after the readback; 'offer' when accepting or declining a seller's refund or replacement offer.",
    ),
};

const DECISIONS = ['confirm', 'hold', 'cancel', 'change', 'none'] as const;

export const confirmationOutput = {
  decision: z.enum(DECISIONS),
  reason: z
    .string()
    .describe(
      'Why, as a short code such as phrase, hold, negation, question, conditional or reported_speech.',
    ),
  reason_explained: z.string(),
  normalised: z.string().describe('The cleaned words the decision was made on.'),
  key1_passed: z.boolean().describe('True only when decision is confirm. This is one key of two.'),
  payment_allowed: z.literal(false).describe('Always false: this tool alone can never authorise a payment.'),
  say: z.string().describe('What to tell the user now, from the template copy.'),
  next_step: z.string().describe('What you, the agent, should do next.'),
};

const REASONS: Record<PhraseReason, string> = {
  phrase: 'The whole utterance is an allowed confirmation phrase.',
  empty: 'Nothing was said.',
  hold: 'The user asked to wait.',
  hedge: 'The user sounded unsure.',
  cancel: 'The user asked to stop.',
  negation: 'The user said no.',
  change: 'The user wants to change something, such as the colour, size or item.',
  question: 'The user asked a question.',
  conditional: 'The user set a condition, such as "if" or "but".',
  reported_speech: 'These sound like someone else\'s words, such as "he said confirm" or the TV.',
  other_language: 'Confirmations are only accepted in English for now.',
  hesitation: 'The user trailed off before finishing.',
  extra_words: 'A confirmation word was mixed with other words, so it is not a clear instruction to pay.',
  affirmative_only: 'A bare "yes" or "okay" is not enough to pay.',
  unrecognised: 'This is not a confirmation phrase.',
};

const SECOND_KEY =
  'A second, independent key is required before any money moves: either a separate classifier that labels this same utterance as a clear, unconditional instruction to pay for exactly the readback just spoken (same text_hash), or a second deliberate press of a Confirm button. If the second key does not agree, do not pay.';

function sayFor(decision: PhraseDecision, reason: PhraseReason, phase: 'readback' | 'offer'): string {
  switch (decision) {
    case 'confirm':
      return '';
    case 'hold':
      return en.confirm.held;
    case 'cancel':
      return phase === 'offer' ? en.cases.declined('the seller') : en.confirm.cancelled;
    case 'change':
      return en.confirm.change;
    case 'none':
      if (phase === 'offer') return en.help.offer;
      if (reason === 'question') return en.confirm.question;
      if (reason === 'conditional') return en.confirm.conditional;
      if (reason === 'other_language') return en.confirm.otherLanguage;
      return en.confirm.needPhrase;
  }
}

function nextStepFor(decision: PhraseDecision, phase: 'readback' | 'offer'): string {
  switch (decision) {
    case 'confirm':
      return `Key 1 passed. ${SECOND_KEY} If both keys agree, pay exactly the total that was read back. If not, say: "${en.confirm.notSure}"`;
    case 'hold':
      return 'Do not pay. Wait for the user with no time limit. The readback stays valid while nothing in the cart changes.';
    case 'cancel':
      return phase === 'offer'
        ? 'Do not accept the offer. Tell the seller it was declined and leave the case open.'
        : 'Do not pay. Keep the cart so the user can come back to it.';
    case 'change':
      return 'Do not pay. Ask what to change, update the cart, then call accessible_readback again and read the new readback in full.';
    case 'none':
      return 'Do not pay. Answer any question first, then ask again. Nothing is confirmed until this tool returns confirm and a second key agrees.';
  }
}

export function checkConfirmationPhrase(utterance: string, phase: 'readback' | 'offer') {
  const m = matchConfirmationPhrase(utterance, { phase });
  return {
    decision: m.decision,
    reason: m.reason,
    reason_explained: REASONS[m.reason],
    normalised: m.normalised,
    key1_passed: m.decision === 'confirm',
    payment_allowed: false as const,
    say: sayFor(m.decision, m.reason, phase),
    next_step: nextStepFor(m.decision, phase),
  };
}

export function registerConfirmation(server: McpServer): void {
  server.registerTool(
    'check_confirmation_phrase',
    {
      title: 'Check a confirmation phrase (key 1 of 2)',
      description: [
        "Deterministic first key of the two-key purchase confirmation. Pass the user's reply to the readback (or to a seller's offer) word for word.",
        'Returns confirm only when the whole utterance is an allowed phrase such as "confirm purchase", "buy it" or "place my order" (fillers like "um" and a leading "yes" are fine).',
        'Returns hold for "wait" or "hold on", cancel for "cancel", "no" or "yeah no", change for colour, size or "instead", and none for questions, conditions ("if it\'s under $40"), hedges, reported speech ("he said confirm"), trailing hesitation, bare "yes", or other languages.',
        'This result alone NEVER authorises a payment. A second, independent key is required before any money moves: a separate classifier agreeing on the same utterance and readback, or a second deliberate press of a Confirm button.',
      ].join(' '),
      inputSchema: confirmationInput,
      outputSchema: confirmationOutput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ utterance, phase }) => {
      const out = checkConfirmationPhrase(utterance, phase);
      const lines = [`Key 1 decision: ${out.decision} (${out.reason}). ${out.reason_explained}`];
      if (out.say) lines.push(`Say to the user: "${out.say}"`);
      lines.push(`Next: ${out.next_step}`);
      return ok(out, lines.join('\n'));
    },
  );
}
