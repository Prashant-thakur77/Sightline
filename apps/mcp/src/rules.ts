import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PRODUCT_NAME } from '@sightline/core';

export const READBACK_RULES_URI = 'sightline://readback-rules';

export function readbackRulesText(): string {
  return `${PRODUCT_NAME} readback and confirmation rules

These rules keep a blind or low-vision shopper in control of every payment. Follow them whenever you buy something for a person who uses a screen reader or voice.

1. The readback
- Before any payment, call accessible_readback with the final cart and speak its text to the user word for word. Do not shorten, paraphrase, reorder, translate or add to it.
- The text comes from a fixed template and the listing facts, never from model wording. Amounts, the payee and quantities come from the cart and are recomputed by the server.
- It always says the item, colour, size, quantity, seller, the total with shipping and tax, how it will be paid, when it arrives and the return policy. Anything the listing does not give is read as "the listing doesn't say". Never fill a gap with a guess.
- text_hash identifies exactly what was spoken. If the item, variant, quantity, price, shipping, tax or seller changes, that readback and any confirmation of it are void. Build a new one and read it in full.
- There is no time limit. Wait for the user for as long as they need.

2. Two-key confirmation
Money moves only when two independent keys agree about the same readback (the same text_hash).
- Key 1 is deterministic. check_confirmation_phrase must return "confirm" for the user's exact words. Only an utterance made entirely of an allowed phrase passes, such as "confirm purchase", "confirm", "buy it", "place my order" or "pay now". Fillers like "um" or "okay" and a leading "yes" are fine. A press of an on-screen Confirm button also counts as key 1.
- Key 2 is independent of key 1. Either a separate classifier labels the same utterance, against the same readback text, as a clear and unconditional instruction to pay now, or the user makes a second deliberate press of the Confirm button (not a double-click).
- One key alone never pays. Model output alone never pays. If key 2 does not agree, say: "I want to be sure before I pay. To pay, say 'confirm purchase'. To stop, say 'cancel'."

3. What never confirms
- Hold: "wait", "hold on", "not yet", "one second", "let me think". Pay nothing and keep waiting.
- Cancel: "cancel", "stop", "never mind", "no", "yeah no". Pay nothing and keep the cart.
- Change: a colour, a size, or words like "change", "instead", "different", "bigger". Pay nothing, update the cart and read a new readback.
- Questions, conditions ("if it's under $40", "but"), hedges ("maybe", "I guess"), reported speech ("he said confirm", the TV), trailing off ("confirm..."), and other languages. Answer, then ask again.
- A bare "yes", "okay" or "sure". Ask the user to say "confirm purchase".

4. After the check on delivery
- verify_delivery returns match, mismatch or unsure. It never says match unless every check that applies agrees.
- Say confidence in words: sure, fairly sure, not sure. Never give percentages.
- If the check service is unavailable there is no verdict. Say the check could not run. Never invent one.
- On a mismatch, offer to build a signed evidence pack with build_evidence_pack for the seller or a PayPal dispute.

5. How to speak
- Short sentences. Say what happens next and how to undo it.
- Never blame the user. Never refer to anything only visible on screen, such as colours of buttons or positions.
- Money always with its currency, as the readback says it.
`;
}

export function registerRules(server: McpServer): void {
  server.registerResource(
    'readback-rules',
    READBACK_RULES_URI,
    {
      title: 'Readback and two-key confirmation rules',
      description: 'How to read a purchase back to a blind shopper and when a payment may be made.',
      mimeType: 'text/plain',
    },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: readbackRulesText() }] }),
  );
}
