import { fail, pass } from '../guard';
import type { Guard, GuardContext, GuardResult } from '../types';

/**
 * Money goes only to the seller on the listing, and only if that seller is on the allowlist.
 * Exact, case-sensitive comparison of PayPal merchant ids: no patterns, no normalising.
 */
export class PayeeGuard implements Guard {
  readonly name = 'PayeeGuard';

  async run({ intent, ports }: GuardContext): Promise<GuardResult> {
    const payee = intent.payee?.merchantId;
    const sellers = [...new Set(intent.cart.lines.map((l) => l.snapshot?.seller?.merchantId))];

    if (sellers.some((s) => typeof s !== 'string' || s.length === 0)) {
      return fail(this.name, 'PAYEE_NOT_ALLOWED', 'A line has no seller merchant id');
    }
    if (sellers.length > 1) {
      return fail(this.name, 'MULTIPLE_SELLERS', 'The cart has items from more than one seller', {
        sellers: sellers as string[],
      });
    }
    const seller = sellers[0] as string;
    if (typeof payee !== 'string' || payee !== seller) {
      return fail(this.name, 'PAYEE_MISMATCH', 'The payee is not the seller on the listing', {
        payee: typeof payee === 'string' ? payee : null,
        seller,
      });
    }

    const allowlist = await ports.payeeAllowlist();
    if (!Array.isArray(allowlist) || !allowlist.includes(payee)) {
      return fail(this.name, 'PAYEE_NOT_ALLOWED', 'The payee is not on the allowlist', { payee });
    }
    return pass(this.name, 'Payee is the listing seller and allowlisted', { payee });
  }
}
