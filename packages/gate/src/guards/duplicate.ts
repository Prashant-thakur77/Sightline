import { fail, pass, timeOf } from '../guard';
import type { Guard, GuardContext, GuardResult } from '../types';
import { holdsSince } from './holds';

/** Orders in these states never took money, so they do not block a retry. */
const NOT_BLOCKING = new Set(['failed', 'voided']);

/** No order, and no in-flight hold, for the same cart hash inside the duplicate window. */
export class DuplicateGuard implements Guard {
  readonly name = 'DuplicateGuard';

  async run({ intent, ports, opts }: GuardContext): Promise<GuardResult> {
    const { cart, now, userId } = intent;
    const nowMs = now.getTime();
    const since = nowMs - opts.duplicateWindowMs;

    const orders = (await ports.recentOrdersForCart(cart.hash, since)).filter(
      (o) => o.cartHash === cart.hash && (timeOf(o.createdAt) ?? nowMs) >= since && !NOT_BLOCKING.has(o.status ?? ''),
    );
    const holds = (await holdsSince(ports, userId, now, since)).filter((r) => r.cartHash === cart.hash);

    const hits = [
      ...orders.map((o) => ({ id: o.id, kind: 'order', at: timeOf(o.createdAt) ?? nowMs })),
      ...holds.map((r) => ({ id: r.id, kind: 'reservation', at: timeOf(r.createdAt) ?? nowMs })),
    ].sort((a, b) => b.at - a.at);

    const latest = hits[0];
    if (latest) {
      return fail(this.name, 'DUPLICATE_ORDER', 'This cart was already ordered recently', {
        existing: latest.id,
        kind: latest.kind,
        ageMs: Math.max(0, nowMs - latest.at),
        windowMs: opts.duplicateWindowMs,
      });
    }
    return pass(this.name, 'No recent order for this cart', { windowMs: opts.duplicateWindowMs });
  }
}
