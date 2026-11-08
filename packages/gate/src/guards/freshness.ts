import type { ProductSnapshot } from '@sightline/core';
import { fail, isMoney, pass, timeOf } from '../guard';
import type { Guard, GuardContext, GuardResult } from '../types';

/**
 * Every snapshot was captured less than `snapshotMaxAgeMs` before the decision.
 * With a `refreshSnapshot` port, an old snapshot is re-read instead: the payment goes ahead only
 * if the listing is still the same item, from the same seller, at the same price.
 */
export class FreshnessGuard implements Guard {
  readonly name = 'FreshnessGuard';

  async run({ intent, ports, opts }: GuardContext): Promise<GuardResult> {
    const now = intent.now.getTime();
    const maxAge = opts.snapshotMaxAgeMs;
    const refreshed: string[] = [];

    for (const line of intent.cart.lines) {
      const s = line.snapshot;
      const capturedAt = timeOf(s.capturedAt);
      if (capturedAt === null || capturedAt > now) {
        return fail(this.name, 'SNAPSHOT_TIME_INVALID', 'Snapshot capture time is missing or in the future', {
          snapshotId: s.id,
          capturedAt: s.capturedAt ?? null,
        });
      }
      const ageMs = now - capturedAt;
      if (ageMs < maxAge) continue;

      if (!ports.refreshSnapshot) {
        return fail(this.name, 'SNAPSHOT_STALE', 'Snapshot is too old', {
          snapshotId: s.id,
          title: s.title,
          ageMs,
          maxAgeMs: maxAge,
        });
      }

      const fresh: ProductSnapshot | null = await ports.refreshSnapshot(s);
      if (!fresh) {
        return fail(this.name, 'LISTING_UNAVAILABLE', 'The listing is no longer available', {
          snapshotId: s.id,
          title: s.title,
        });
      }
      const freshAt = timeOf(fresh.capturedAt);
      if (freshAt === null || freshAt > now || now - freshAt >= maxAge) {
        return fail(this.name, 'SNAPSHOT_STALE', 'Refreshed snapshot is not fresh', {
          snapshotId: s.id,
          title: s.title,
          ageMs,
          maxAgeMs: maxAge,
        });
      }
      if (
        fresh.productId !== s.productId ||
        fresh.variantId !== s.variantId ||
        fresh.seller?.merchantId !== s.seller.merchantId
      ) {
        return fail(this.name, 'LISTING_CHANGED', 'The listing now describes a different item or seller', {
          snapshotId: s.id,
          title: s.title,
        });
      }
      if (!isMoney(fresh.price) || fresh.price.cents !== s.price.cents || fresh.price.currency !== s.price.currency) {
        return fail(this.name, 'PRICE_CHANGED', 'The price changed since the readback', {
          snapshotId: s.id,
          title: s.title,
          from: s.price,
          to: isMoney(fresh.price) ? fresh.price : null,
        });
      }
      refreshed.push(s.id);
    }

    return pass(this.name, 'All snapshots are fresh', { maxAgeMs: maxAge, refreshed });
  }
}
