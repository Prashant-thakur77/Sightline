import { formatMoneyShort } from '@sightline/core';
import { MINUTE, isMoney } from './guard';
import type { GateCode } from './types';

/**
 * What the agent says when the gate refuses. Short sentences, never blames the user, always
 * says what happened to their money and what happens next. Amounts come from the guard
 * details (snapshots and limits), never from model text.
 */

function money(v: unknown): string | null {
  return isMoney(v) ? formatMoneyShort(v) : null;
}

function ago(ms: unknown): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 45_000) return 'just now';
  if (ms < 90_000) return 'a minute ago';
  return `${Math.round(ms / MINUTE)} minutes ago`;
}

function minutes(ms: unknown, fallback: number): number {
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? Math.round(ms / MINUTE) : fallback;
}

const FALLBACK = "I couldn't complete the payment, so I didn't charge you. Your cart is saved.";

export function refusalSentence(code: GateCode | string, details: Record<string, unknown> = {}): string {
  switch (code as GateCode) {
    case 'OK':
      return '';
    case 'ENV_NOT_SANDBOX':
      return "Payments are switched off on this server, so I didn't charge you. Your cart is saved.";
    case 'INVALID_CLOCK':
    case 'UNSUPPORTED_MODE':
    case 'GUARD_ERROR':
    case 'RECEIPT_WRITE_FAILED':
    case 'LIMITS_UNAVAILABLE':
      return "Something went wrong on my side, so I didn't charge you. Your cart is saved. Try again in a moment.";
    case 'READBACK_MISSING':
      return "I need to read your order to you before I buy it. I'll read it now.";
    case 'READBACK_TAMPERED':
    case 'CART_TAMPERED':
      return "Something in your order didn't check out, so I didn't charge you. I'll read it to you again.";
    case 'READBACK_CART_MISMATCH':
      return "Your cart changed after I read it to you, so I didn't charge you. I'll read the new cart.";
    case 'USER_MISMATCH':
      return "That cart isn't linked to this account, so I didn't charge you. Your own cart is unchanged.";
    case 'NOT_CONFIRMED':
      return "I didn't hear a confirmation, so I didn't buy it. Say \"confirm purchase\" when you're ready.";
    case 'SINGLE_KEY_CONFIRMATION':
      return "I wasn't sure that was a yes, so I didn't buy it. Say \"confirm purchase\" if you want it.";
    case 'CONFIRMATION_OUT_OF_ORDER':
      return "I didn't buy it yet. I'll read your order again, then you can confirm.";
    case 'CONFIRMATION_EXPIRED':
      return "It's been a while since I read your order, so I didn't buy it yet. I'll read it again, then you can confirm.";
    case 'CART_EMPTY':
      return "Your cart is empty, so there's nothing to buy. Tell me what you'd like to find.";
    case 'INVALID_QUANTITY':
      return "One of the quantities in your cart doesn't look right, so I didn't charge you. I'll read the cart again.";
    case 'CURRENCY_MISMATCH':
      return "The prices are in different currencies, so I didn't charge you. I'll read the cart again.";
    case 'AMOUNT_INVALID':
      return "I couldn't confirm the amount, so I didn't charge you. I'll read the total from the store again.";
    case 'TOTALS_MISMATCH':
      return "The total didn't add up, so I didn't charge you. I'll work it out again and read it to you.";
    case 'AMOUNT_MISMATCH': {
      const expected = money(details.expected);
      return expected
        ? `The amount didn't match the store's total of ${expected}, so I didn't charge you. I'll read the total again.`
        : "The amount didn't match the store's total, so I didn't charge you. I'll read the total again.";
    }
    case 'PAYEE_NOT_ALLOWED':
      return "That seller isn't on the list I can pay, so I didn't charge you. I can look for the same thing from another shop.";
    case 'PAYEE_MISMATCH':
      return "The payment was set to go to someone other than the seller, so I stopped it. You weren't charged. I'll read the order again.";
    case 'MULTIPLE_SELLERS':
      return "Your cart has items from more than one seller. I'll buy from one seller at a time. Which one first?";
    case 'OVER_ORDER_LIMIT': {
      const limit = money(details.limit);
      return `That's over your ${limit ? `${limit} ` : ''}limit for one order. You can raise the limit in settings, or pick something else.`;
    }
    case 'OVER_DAILY_LIMIT': {
      const limit = money(details.limit);
      const remaining = isMoney(details.remaining) ? details.remaining : null;
      const left =
        remaining === null ? '' : remaining.cents > 0 ? ` You have ${money(remaining)} left today.` : " You've used it all today.";
      return `That's over your ${limit ? `${limit} ` : ''}limit for today.${left} You can raise the limit in settings, or try again tomorrow.`;
    }
    case 'DUPLICATE_ORDER':
      return `You already bought this ${ago(details.ageMs)}, so I didn't charge you again.`;
    case 'RATE_LIMITED': {
      const limit = typeof details.limit === 'number' ? details.limit : null;
      const over = limit === null ? 'more orders in an hour than your limit' : `more than ${limit} orders in an hour`;
      return `That's ${over}, so I didn't place this one. You can try again later, or change the limit in settings.`;
    }
    case 'SNAPSHOT_STALE':
      return `I last checked this price more than ${minutes(details.maxAgeMs, 15)} minutes ago, so I didn't charge you. I'll check it again and read you the total.`;
    case 'SNAPSHOT_TIME_INVALID':
      return "I couldn't tell when I last checked the price, so I didn't charge you. I'll check it again.";
    case 'PRICE_CHANGED': {
      const from = money(details.from);
      const to = money(details.to);
      return from && to
        ? `The price changed from ${from} to ${to} since I read it to you. I'll read the new total.`
        : "The price changed since I read it to you. I'll read the new total.";
    }
    case 'LISTING_CHANGED':
      return "The listing changed since I read it to you, so I didn't charge you. I'll read it again.";
    case 'LISTING_UNAVAILABLE':
      return "That item isn't available any more, so I didn't charge you. I can look for something similar.";
    default:
      return FALLBACK;
  }
}
