import { DAY, fail, isMoney, pass } from '../guard';
import type { Guard, GuardContext, GuardResult } from '../types';
import { holdsSince, sumCents, validLimits } from './holds';

/**
 * Per-order cap, then the daily cap over committed spend plus active holds plus this order.
 * This read-only check is repeated atomically by the reservation port when the gate passes.
 */
export class BudgetGuard implements Guard {
  readonly name = 'BudgetGuard';

  async run({ intent, ports }: GuardContext): Promise<GuardResult> {
    const { amount, userId, now } = intent;
    const limits = await ports.limits(userId);
    if (!validLimits(limits)) return fail(this.name, 'LIMITS_UNAVAILABLE', 'Spending limits are missing or invalid');
    if (!isMoney(amount)) return fail(this.name, 'AMOUNT_INVALID', 'The amount is not valid money');

    const { perOrderCap, dailyCap } = limits;
    if (perOrderCap.currency !== amount.currency || dailyCap.currency !== amount.currency) {
      return fail(this.name, 'CURRENCY_MISMATCH', 'Limits are in a different currency', {
        amountCurrency: amount.currency,
        limitCurrency: perOrderCap.currency,
      });
    }
    if (amount.cents > perOrderCap.cents) {
      return fail(this.name, 'OVER_ORDER_LIMIT', 'Amount is over the per-order cap', { limit: perOrderCap, amount });
    }

    const spent = await ports.spentToday(userId, now);
    if (!isMoney(spent) || spent.currency !== amount.currency) {
      return fail(this.name, 'LIMITS_UNAVAILABLE', "Today's spend is unavailable");
    }
    const holds = await holdsSince(ports, userId, now, now.getTime() - DAY);
    const heldCents = sumCents(holds.filter((h) => h.amount.currency === amount.currency));
    const projected = spent.cents + heldCents + amount.cents;
    const remaining = Math.max(0, dailyCap.cents - spent.cents - heldCents);
    const currency = amount.currency;

    if (projected > dailyCap.cents) {
      return fail(this.name, 'OVER_DAILY_LIMIT', 'Amount would exceed the daily cap', {
        limit: dailyCap,
        spent,
        held: { cents: heldCents, currency },
        amount,
        remaining: { cents: remaining, currency },
      });
    }
    return pass(this.name, 'Within per-order and daily caps', {
      perOrderCap,
      dailyCap,
      spent,
      held: { cents: heldCents, currency },
      remainingAfter: { cents: dailyCap.cents - projected, currency },
    });
  }
}
