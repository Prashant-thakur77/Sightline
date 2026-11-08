import {
  canonicalJson,
  hashReadbackBinding,
  hashSnapshot,
  paypalRequestId,
  signReceipt,
} from '@sightline/evidence';
import { DAY, MINUTE, errorName, fail, isValidDate, pass } from './guard';
import { BudgetGuard } from './guards/budget';
import { CatalogPriceGuard } from './guards/catalogPrice';
import { DuplicateGuard } from './guards/duplicate';
import { EnvGuard } from './guards/env';
import { FreshnessGuard } from './guards/freshness';
import { PayeeGuard } from './guards/payee';
import { RateLimitGuard } from './guards/rateLimit';
import { ReadbackBindingGuard } from './guards/readbackBinding';
import { refusalSentence } from './refusal';
import {
  GATE_RECEIPT_SCHEMA,
  type GateDecision,
  type GateOptions,
  type GatePorts,
  type GateReceiptBody,
  type Guard,
  type GuardResult,
  type PaymentIntent,
  type Reservation,
  type ResolvedGateOptions,
} from './types';

export const DEFAULT_CONFIRM_WINDOW_MS = 5 * MINUTE;
export const DUPLICATE_WINDOW_MS = 10 * MINUTE;
export const SNAPSHOT_MAX_AGE_MS = 15 * MINUTE;
export const CAPTURE_RESERVATION_TTL_MS = 30 * MINUTE;
/** PayPal authorizations stay valid for 29 days; the hold has to last as long. */
export const AUTHORIZE_RESERVATION_TTL_MS = 29 * DAY;

/** The fixed guard order. Every one must pass; the first failure stops the run. */
export const GUARD_ORDER = [
  'EnvGuard',
  'ReadbackBindingGuard',
  'CatalogPriceGuard',
  'PayeeGuard',
  'BudgetGuard',
  'DuplicateGuard',
  'RateLimitGuard',
  'FreshnessGuard',
] as const;

/** A fresh chain in GUARD_ORDER. The gate always runs all of them; callers cannot swap any out. */
export function createGuards(): Guard[] {
  return [
    new EnvGuard(),
    new ReadbackBindingGuard(),
    new CatalogPriceGuard(),
    new PayeeGuard(),
    new BudgetGuard(),
    new DuplicateGuard(),
    new RateLimitGuard(),
    new FreshnessGuard(),
  ];
}

function positive(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/** Fill defaults. Safety windows can be made stricter by configuration, never looser. */
export function resolveOptions(opts: GateOptions, intent: Pick<PaymentIntent, 'intent'>): ResolvedGateOptions {
  return {
    env: opts.env ?? {},
    confirmWindowMs: positive(opts.confirmWindowMs) ? opts.confirmWindowMs : DEFAULT_CONFIRM_WINDOW_MS,
    duplicateWindowMs: Math.max(DUPLICATE_WINDOW_MS, positive(opts.duplicateWindowMs) ? opts.duplicateWindowMs : 0),
    snapshotMaxAgeMs: Math.min(SNAPSHOT_MAX_AGE_MS, positive(opts.snapshotMaxAgeMs) ? opts.snapshotMaxAgeMs : Infinity),
    reservationTtlMs: positive(opts.reservationTtlMs)
      ? opts.reservationTtlMs
      : intent.intent === 'AUTHORIZE'
        ? AUTHORIZE_RESERVATION_TTL_MS
        : CAPTURE_RESERVATION_TTL_MS,
  };
}

/** PayPal-Request-Id for the order: same cart and same readback, same id. */
export function orderRequestId(intent: Pick<PaymentIntent, 'cart' | 'readback'>): string {
  const clean = (v: unknown) => (typeof v === 'string' ? v.replace(/\u001f/g, '') : '');
  return paypalRequestId('order', clean(intent.cart?.hash), clean(intent.readback?.id));
}

/** Keep the receipt serialisable whatever the input looked like. */
function jsonSafe(v: unknown): unknown {
  try {
    canonicalJson(v ?? null);
    return v ?? null;
  } catch {
    return { unserialisable: typeof v };
  }
}

function attempt<T>(f: () => T, fallback: T): T {
  try {
    return f();
  } catch {
    return fallback;
  }
}

function receiptBody(
  intent: PaymentIntent,
  opts: ResolvedGateOptions,
  requestId: string,
  results: GuardResult[],
  allowed: boolean,
  reservation: Reservation | undefined,
): GateReceiptBody {
  const rb = intent.readback;
  const c = rb?.confirmation;
  const lines = Array.isArray(intent.cart?.lines) ? intent.cart.lines : [];
  return {
    schema: GATE_RECEIPT_SCHEMA,
    decidedAt: isValidDate(intent.now) ? intent.now.toISOString() : 'invalid',
    requestId,
    allowed,
    firstFailure: results.find((r) => !r.ok)?.code ?? null,
    env: { paypalEnv: opts.env.PAYPAL_ENV ?? null, apiBase: opts.env.PAYPAL_API_BASE ?? null },
    input: {
      userId: String(intent.userId),
      cartId: String(intent.cart?.id),
      cartHash: String(intent.cart?.hash),
      readbackId: rb ? String(rb.id) : null,
      readbackCartHash: rb ? String(rb.cartHash) : null,
      readbackTextHash: rb ? String(rb.textHash) : null,
      readbackBindingHash: rb ? attempt(() => hashReadbackBinding(rb), null) : null,
      confirmation: c
        ? {
            phraseMatched: c.phraseMatched === true,
            classifierAgreed: c.classifierAgreed === true,
            utterance: String(c.utterance),
            at: String(c.at),
            confirmedAt: rb?.confirmedAt ?? null,
            holdOpen: rb?.holdOpen === true,
          }
        : null,
      payee: String(intent.payee?.merchantId),
      amount: jsonSafe(intent.amount),
      paymentSource: String(intent.paymentSource),
      intent: String(intent.intent),
      lines: lines.map((l) => ({
        snapshotId: String(l?.snapshot?.id),
        snapshotHash: attempt(() => hashSnapshot(l.snapshot), 'unhashable'),
        merchantId: String(l?.snapshot?.seller?.merchantId),
        unitPrice: jsonSafe(l?.snapshot?.price),
        quantity: jsonSafe(l?.quantity),
        capturedAt: String(l?.snapshot?.capturedAt),
      })),
      totals: jsonSafe(intent.cart?.totals),
    },
    results: results.map((r) => ({ ...r, details: jsonSafe(r.details) as Record<string, unknown> })),
    reservation: reservation ? { id: reservation.id, expiresAt: reservation.expiresAt } : null,
  };
}

/**
 * Run every guard in order and decide. Deterministic for a given intent and port state.
 *
 * - The first failing guard stops the run; a guard that throws fails closed (GUARD_ERROR).
 * - When all guards pass and a reservation port is present, the budget hold is taken
 *   atomically; if a concurrent confirmation got there first, the decision is a refusal.
 * - A signed receipt is produced for every decision and handed to `ports.recordReceipt`.
 *   If recording fails, any hold is released and the decision becomes a refusal.
 */
export async function runGate(intent: PaymentIntent, ports: GatePorts, opts: GateOptions): Promise<GateDecision> {
  const resolved = resolveOptions(opts, intent);
  const ctx = { intent, ports, opts: resolved };
  const requestId = orderRequestId(intent);
  const results: GuardResult[] = [];

  for (const guard of createGuards()) {
    let r: GuardResult;
    try {
      r = await guard.run(ctx);
    } catch (e) {
      r = fail(guard.name, 'GUARD_ERROR', 'Guard could not complete', { error: errorName(e) });
    }
    results.push(r);
    if (!r.ok) break;
  }

  const guardsPassed =
    results.length === GUARD_ORDER.length && results.every((r, i) => r.ok && r.guard === GUARD_ORDER[i]);

  let reservation: Reservation | undefined;
  if (guardsPassed && ports.reservations) {
    try {
      const limits = await ports.limits(intent.userId);
      const outcome = await ports.reservations.reserve({
        key: requestId,
        userId: intent.userId,
        cartHash: intent.cart.hash,
        amount: intent.amount,
        now: intent.now,
        expiresAt: new Date(intent.now.getTime() + resolved.reservationTtlMs),
        limits,
        duplicateWindowMs: resolved.duplicateWindowMs,
      });
      if (outcome.ok) {
        reservation = outcome.reservation;
        results.push(
          pass('Reservation', 'Budget held until capture', {
            reservationId: reservation.id,
            expiresAt: reservation.expiresAt,
          }),
        );
      } else {
        results.push(fail('Reservation', outcome.code, 'The budget hold was refused', outcome.details));
      }
    } catch (e) {
      results.push(fail('Reservation', 'GUARD_ERROR', 'The budget hold could not be taken', { error: errorName(e) }));
    }
  }

  const decide = (rs: GuardResult[], hold: Reservation | undefined): GateDecision => {
    const firstFailure = rs.find((r) => !r.ok);
    const allowed = guardsPassed && !firstFailure;
    const receipt = signReceipt(receiptBody(intent, resolved, requestId, rs, allowed, hold), opts.signingKey);
    return {
      allowed,
      results: rs,
      firstFailure,
      refusal: firstFailure ? refusalSentence(firstFailure.code, firstFailure.details) : undefined,
      receipt,
      requestId,
      reservation: allowed ? hold : undefined,
    };
  };

  const decision = decide(results, reservation);
  if (!ports.recordReceipt) return decision;

  try {
    await ports.recordReceipt(decision.receipt);
    return decision;
  } catch (e) {
    if (reservation && ports.reservations) {
      try {
        await ports.reservations.release(reservation.id, 'receipt_write_failed', intent.now);
      } catch {
        // The hold will expire on its own; the refusal below still stands.
      }
    }
    const failed = [...results, fail('ReceiptWriter', 'RECEIPT_WRITE_FAILED', 'The receipt could not be saved', { error: errorName(e) })];
    return decide(failed, undefined);
  }
}
