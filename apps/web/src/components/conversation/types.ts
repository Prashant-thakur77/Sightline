/** The contract between the conversation UI and POST /api/turn. */

export type Politeness = 'polite' | 'assertive';

export interface ChatMessage {
  id: string;
  role: 'user' | 'agent';
  text: string;
}

export interface OptionItem {
  index: number;
  productId: string;
  title: string;
  brand?: string;
  colour?: string;
  size?: string;
  price: string;
  returns: string;
  available: boolean;
  imageUrl?: string;
  imageAlt?: string;
  why: string[];
  /** The shopping agent's one-line reason this option fits, checked against the listing. */
  pick?: string;
}

export interface Fact {
  label: string;
  value: string;
  /** Where the fact came from: "listing", or a quoted review. */
  source?: string;
}

export type Card =
  | { kind: 'options'; heading: string; items: OptionItem[] }
  | { kind: 'details'; heading: string; item: OptionItem; facts: Fact[]; quotes: { text: string; source: string }[] }
  | { kind: 'compare'; heading: string; columns: string[]; rows: { label: string; values: string[] }[] }
  | {
      kind: 'readback';
      heading: string;
      readbackId: string;
      fields: { key: string; label: string; value: string }[];
      text: string;
      total: string;
      payWith: string;
      /** False when this server has no PayPal keys: confirming can't pay, and the card says so. */
      paypalConnected: boolean;
      needsSecondPress: boolean;
      held: boolean;
    }
  | {
      /** A store's offer on an open case, with Accept (two presses) and Decline in the card. */
      kind: 'offer';
      heading: string;
      offerId: string;
      orderId: string;
      /** What was offered, what accepting means, and that it can't be undone. */
      text: string;
      /** The store agent's reasons, checked against the case's facts, when its agent made the offer. */
      reasons?: string[];
      byAgent?: boolean;
      needsSecondPress: boolean;
    }
  | { kind: 'paypal'; heading: string; readbackId: string; paypalOrderId: string; total: string; clientId: string; orderIntent: 'CAPTURE' | 'AUTHORIZE' }
  | {
      kind: 'paid';
      heading: string;
      orderId: string;
      amount: string;
      merchant: string;
      receiptId?: string;
      payAfterCheck: boolean;
    }
  | { kind: 'refusal'; heading: string; reason: string; code: string }
  | { kind: 'help'; heading: string; groups: { title: string; phrases: string[] }[] }
  | { kind: 'link'; heading: string; text: string; href: string; label: string };

export interface TurnResponse {
  messages: ChatMessage[];
  say: string;
  politeness: Politeness;
  cue?: 'done' | 'attention' | 'error' | 'paid' | 'thinking';
  card: Card | null;
  suggestions: { label: string; utterance: string }[];
  phase: string;
  /** A setting changed by voice that the page applies at once (the app's own voice rate, in percent). */
  settings?: { speechRate?: number };
}

export type TurnRequest =
  | { text: string; source: 'voice' | 'keyboard' }
  | { action: 'choose'; index: number }
  | { action: 'details'; index: number }
  | { action: 'buy'; index: number }
  | { action: 'confirm-button'; readbackId: string }
  | { action: 'hold'; readbackId: string }
  | { action: 'cancel' }
  | { action: 'paypal-approved'; readbackId: string; paypalOrderId: string }
  /** The offer card's buttons. Accept needs two presses; the first only asks for the second. */
  | { action: 'offer-accept'; offerId: string }
  | { action: 'offer-decline'; offerId: string }
  | { action: 'repeat' }
  | { action: 'start' }
  /** Opened from an order page to hear the store's waiting offer, instead of the greeting. */
  | { action: 'offer' };
