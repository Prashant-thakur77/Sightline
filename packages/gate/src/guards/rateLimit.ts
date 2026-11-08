import { HOUR, fail, pass } from '../guard';
import type { Guard, GuardContext, GuardResult } from '../types';
import { holdsSince, validLimits } from './holds';

/** At most `maxOrdersPerHour` orders in a sliding hour, counting in-flight holds. */
export class RateLimitGuard implements Guard {
  readonly name = 'RateLimitGuard';

  async run({ intent, ports }: GuardContext): Promise<GuardResult> {
    const { userId, now } = intent;
    const limits = await ports.limits(userId);
    if (!validLimits(limits)) return fail(this.name, 'LIMITS_UNAVAILABLE', 'Spending limits are missing or invalid');

    const placed = await ports.ordersInLastHour(userId, now);
    if (typeof placed !== 'number' || !Number.isInteger(placed) || placed < 0) {
      return fail(this.name, 'LIMITS_UNAVAILABLE', 'Order count is unavailable');
    }
    const held = (await holdsSince(ports, userId, now, now.getTime() - HOUR)).length;
    const count = placed + held;

    if (count >= limits.maxOrdersPerHour) {
      return fail(this.name, 'RATE_LIMITED', 'Too many orders in the last hour', {
        limit: limits.maxOrdersPerHour,
        count,
      });
    }
    return pass(this.name, 'Under the hourly order limit', { limit: limits.maxOrdersPerHour, count });
  }
}
