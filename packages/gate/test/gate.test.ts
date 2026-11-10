import { describe, expect, it, vi } from 'vitest';
import { paypalRequestId, receiptHash, verifyReceipt } from '@sightline/evidence';
import {
  AUTHORIZE_RESERVATION_TTL_MS,
  GUARD_ORDER,
  InMemoryLedger,
  runGate,
  type GateReceiptBody,
} from '../src';
import type { SignedReceipt } from '@sightline/evidence';
import { KEY, MIN, NOW, OPTS, ago, makeCart, makeIntent, makePorts, makeReadback, makeSnapshot, usd } from './fixtures';

describe('runGate', () => {
  it('allows a clean intent, runs every guard in order, holds the budget and signs a receipt', async () => {
    const intent = makeIntent();
    const ports = makePorts();
    const d = await runGate(intent, ports, OPTS);

    expect(d.allowed).toBe(true);
    expect(d.firstFailure).toBeUndefined();
    expect(d.refusal).toBeUndefined();
    expect(d.results.map((r) => r.guard)).toEqual([...GUARD_ORDER, 'Reservation']);
    expect(d.results.every((r) => r.ok && r.code === 'OK')).toBe(true);
    expect(d.requestId).toBe(paypalRequestId('order', intent.cart.hash, 'rb_1'));
    expect(d.reservation).toMatchObject({ status: 'reserved', amount: usd(3672), key: d.requestId });
    expect(verifyReceipt(d.receipt, KEY)).toEqual({ ok: true });
    expect(d.receipt.body).toMatchObject({
      allowed: true,
      firstFailure: null,
      requestId: d.requestId,
      decidedAt: NOW.toISOString(),
      input: { cartHash: intent.cart.hash, payee: 'MERCHANT1', amount: usd(3672), readbackId: 'rb_1' },
      reservation: { id: d.reservation!.id },
    });
  });

  it('works without a reservation port (checks only, no hold)', async () => {
    const d = await runGate(makeIntent(), makePorts({ reservations: undefined }), OPTS);
    expect(d.allowed).toBe(true);
    expect(d.results.map((r) => r.guard)).toEqual([...GUARD_ORDER]);
    expect(d.reservation).toBeUndefined();
  });

  it('stops at the first failure in guard order and never runs later guards', async () => {
    const stale = makeCart([{ snapshot: makeSnapshot({ capturedAt: ago(30 * MIN) }), quantity: 1 }]);
    const limits = vi.fn(() => ({ perOrderCap: usd(1), dailyCap: usd(1), maxOrdersPerHour: 0 }));
    const intent = makeIntent({ cart: stale, payee: { merchantId: 'ATTACKER' } });
    const d = await runGate(intent, makePorts({ limits }), OPTS);

    expect(d.allowed).toBe(false);
    expect(d.firstFailure).toMatchObject({ guard: 'PayeeGuard', code: 'PAYEE_MISMATCH' });
    expect(d.results.map((r) => r.guard)).toEqual(GUARD_ORDER.slice(0, 5));
    expect(limits).not.toHaveBeenCalled();
    expect(d.reservation).toBeUndefined();
    expect(d.receipt.body.firstFailure).toBe('PAYEE_MISMATCH');
  });

  it('fails closed when a port throws, without leaking the error text', async () => {
    const ports = makePorts({
      payeeAllowlist: () => {
        throw new Error('postgres://admin:hunter2@db/sightline');
      },
    });
    const d = await runGate(makeIntent(), ports, OPTS);
    expect(d.allowed).toBe(false);
    expect(d.firstFailure).toMatchObject({ guard: 'PayeeGuard', code: 'GUARD_ERROR', details: { error: 'Error' } });
    expect(JSON.stringify(d.receipt)).not.toContain('hunter2');
  });

  it('refuses an injected amount and says the real total', async () => {
    const d = await runGate(makeIntent({ amount: usd(1) }), makePorts(), OPTS);
    expect(d.firstFailure).toMatchObject({ code: 'AMOUNT_MISMATCH' });
    expect(d.refusal).toContain('$36.72');
    expect(d.reservation).toBeUndefined();
  });

  it('refuses a stale snapshot as the last guard', async () => {
    const cart = makeCart([{ snapshot: makeSnapshot({ capturedAt: ago(16 * MIN) }), quantity: 1 }]);
    const d = await runGate(makeIntent({ cart }), makePorts(), OPTS);
    expect(d.firstFailure).toMatchObject({ guard: 'FreshnessGuard', code: 'SNAPSHOT_STALE' });
    expect(d.results).toHaveLength(GUARD_ORDER.length);
  });
});

describe('concurrent confirmations with reservations', () => {
  const tight = (daily: number, perHour = 5) => () => ({ perOrderCap: usd(10_000), dailyCap: usd(daily), maxOrdersPerHour: perHour });
  const cartOf = (id: string, cents: number) =>
    makeCart([{ snapshot: makeSnapshot({ id: `snap_${id}`, productId: id, price: usd(cents) }), quantity: 1 }], { id, tax: 0 });

  it('two different $60 orders against a $100 daily cap: exactly one passes', async () => {
    const ports = makePorts({ limits: tight(10_000) });
    const a = makeIntent({ cart: cartOf('a', 6000) });
    const b = makeIntent({ cart: cartOf('b', 6000) });
    const [da, db] = await Promise.all([runGate(a, ports, OPTS), runGate(b, ports, OPTS)]);

    // Both read the same spend before either held anything, so both guard runs passed...
    expect(da.results.find((r) => r.guard === 'BudgetGuard')?.ok).toBe(true);
    expect(db.results.find((r) => r.guard === 'BudgetGuard')?.ok).toBe(true);
    // ...and the atomic hold let only one through.
    expect([da.allowed, db.allowed].filter(Boolean)).toHaveLength(1);
    const loser = da.allowed ? db : da;
    expect(loser.firstFailure).toMatchObject({ guard: 'Reservation', code: 'OVER_DAILY_LIMIT' });
    expect(loser.refusal).toMatch(/limit for today/);
    expect(ports.ledger.active('user_1', NOW)).toHaveLength(1);
  });

  it('a double-click on the same confirmation charges once', async () => {
    const ports = makePorts();
    const intent = makeIntent();
    const decisions = await Promise.all([runGate(intent, ports, OPTS), runGate(intent, ports, OPTS)]);
    expect(decisions.filter((d) => d.allowed)).toHaveLength(1);
    expect(decisions.find((d) => !d.allowed)?.firstFailure?.code).toBe('DUPLICATE_ORDER');
    expect(decisions[0]!.requestId).toBe(decisions[1]!.requestId);
  });

  it('five concurrent orders against a limit of two per hour: two pass', async () => {
    const ports = makePorts({ limits: tight(100_000, 2) });
    const intents = ['a', 'b', 'c', 'd', 'e'].map((id) => makeIntent({ cart: cartOf(id, 1000) }));
    const decisions = await Promise.all(intents.map((i) => runGate(i, ports, OPTS)));
    expect(decisions.filter((d) => d.allowed)).toHaveLength(2);
    expect(decisions.filter((d) => d.firstFailure?.code === 'RATE_LIMITED')).toHaveLength(3);
  });

  it('commit on capture keeps the money counted; release on failure frees it', async () => {
    const ports = makePorts({ limits: tight(10_000) });
    const first = await runGate(makeIntent({ cart: cartOf('a', 6000) }), ports, OPTS);
    expect(first.allowed).toBe(true);

    // Capture failed: release, and the same budget is available again.
    ports.ledger.release(first.reservation!.id, 'capture_failed', NOW);
    const second = await runGate(makeIntent({ cart: cartOf('b', 6000) }), ports, OPTS);
    expect(second.allowed).toBe(true);

    // Capture landed: commit moves the hold into spend, which still blocks a third order.
    ports.ledger.commit(second.reservation!.id, NOW);
    expect(ports.ledger.spentToday('user_1', NOW)).toEqual(usd(6000));
    expect(ports.ledger.active('user_1', NOW)).toHaveLength(0);
    const third = await runGate(makeIntent({ cart: cartOf('c', 6000) }), ports, OPTS);
    expect(third.firstFailure).toMatchObject({ guard: 'BudgetGuard', code: 'OVER_DAILY_LIMIT' });
  });

  it('holds an AUTHORIZE order for the life of the authorization, until void releases it', async () => {
    const ports = makePorts();
    const d = await runGate(makeIntent({ intent: 'AUTHORIZE' }), ports, OPTS);
    expect(Date.parse(d.reservation!.expiresAt) - NOW.getTime()).toBe(AUTHORIZE_RESERVATION_TTL_MS);
    const voided = ports.ledger.release(d.reservation!.id, 'voided', NOW);
    expect(voided.status).toBe('released');
    expect(() => ports.ledger.commit(d.reservation!.id, NOW)).toThrow(/released/);
  });

  it('an expired hold stops counting', async () => {
    const ports = makePorts({ limits: tight(10_000) });
    const first = await runGate(makeIntent({ cart: cartOf('a', 6000) }), ports, { ...OPTS, reservationTtlMs: MIN });
    expect(first.allowed).toBe(true);
    const later = new Date(NOW.getTime() + 2 * MIN);
    const cart = cartOf('b', 6000);
    const rb = makeReadback(cart, {
      createdAt: ago(2 * MIN, later),
      confirmedAt: ago(MIN, later),
      confirmation: { phraseMatched: true, classifierAgreed: true, utterance: 'confirm', at: ago(MIN, later) },
    });
    const second = await runGate(makeIntent({ cart, readback: rb, now: later }), ports, OPTS);
    expect(second.allowed).toBe(true);
  });
});

describe('gate receipts', () => {
  it('signs a verifiable receipt for a refusal too', async () => {
    const d = await runGate(makeIntent({ readback: null }), makePorts(), OPTS);
    expect(d.allowed).toBe(false);
    expect(verifyReceipt(d.receipt, KEY)).toEqual({ ok: true });
    expect(d.receipt.body).toMatchObject({ allowed: false, firstFailure: 'READBACK_MISSING', input: { readbackId: null } });
  });

  it('a receipt flipped to allowed fails verification, re-hashed or not', async () => {
    const d = await runGate(makeIntent({ amount: usd(1) }), makePorts(), OPTS);
    const body = { ...d.receipt.body, allowed: true, firstFailure: null };
    expect(verifyReceipt({ ...d.receipt, body }, KEY)).toEqual({ ok: false, reason: 'hash_mismatch' });
    expect(verifyReceipt({ body, hash: receiptHash(body), signature: d.receipt.signature }, KEY)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('carries no secrets', async () => {
    const d = await runGate(makeIntent(), makePorts(), OPTS);
    const text = JSON.stringify(d.receipt);
    expect(text).not.toContain(KEY);
    expect(Object.keys(d.receipt.body.env)).toEqual(['paypalEnv', 'apiBase']);
  });

  it('records the receipt for every decision', async () => {
    const recorded: SignedReceipt<GateReceiptBody>[] = [];
    const ports = makePorts({ recordReceipt: (r) => void recorded.push(r) });
    await runGate(makeIntent(), ports, OPTS);
    await runGate(makeIntent({ payee: { merchantId: 'ATTACKER' } }), ports, OPTS);
    expect(recorded.map((r) => r.body.allowed)).toEqual([true, false]);
  });

  it('refuses and releases the hold when the receipt cannot be saved', async () => {
    const ports = makePorts({
      recordReceipt: () => {
        throw new Error('disk full');
      },
    });
    const d = await runGate(makeIntent(), ports, OPTS);
    expect(d.allowed).toBe(false);
    expect(d.firstFailure).toMatchObject({ guard: 'ReceiptWriter', code: 'RECEIPT_WRITE_FAILED' });
    expect(d.reservation).toBeUndefined();
    expect(ports.ledger.active('user_1', NOW)).toHaveLength(0);
    expect(verifyReceipt(d.receipt, KEY)).toEqual({ ok: true });
  });

  it('survives junk input and still signs a receipt', async () => {
    const intent = makeIntent({ amount: { cents: Number.NaN, currency: 'USD' } });
    const d = await runGate(intent, makePorts(), OPTS);
    expect(d.firstFailure?.code).toBe('AMOUNT_INVALID');
    expect(d.receipt.body.input.amount).toEqual({ unserialisable: 'object' });
    expect(verifyReceipt(d.receipt, KEY)).toEqual({ ok: true });
  });
});

describe('requestId', () => {
  it('is the same for the same cart and readback, across runs and outcomes', async () => {
    const intent = makeIntent();
    const a = await runGate(intent, makePorts(), OPTS);
    const b = await runGate({ ...intent, amount: usd(5) }, makePorts(), OPTS);
    expect(a.requestId).toBe(b.requestId);
    expect(a.requestId).toMatch(/^[a-z2-7]{36}$/);
  });

  it('differs for a different readback or a different cart', async () => {
    const cart = makeCart();
    const base = await runGate(makeIntent({ cart }), makePorts(), OPTS);
    const otherReadback = await runGate(makeIntent({ cart, readback: makeReadback(cart, { id: 'rb_2' }) }), makePorts(), OPTS);
    const otherCart = await runGate(makeIntent({ cart: makeCart(undefined, { tax: 0 }) }), makePorts(), OPTS);
    expect(otherReadback.requestId).not.toBe(base.requestId);
    expect(otherCart.requestId).not.toBe(base.requestId);
  });
});

describe('ledger', () => {
  it('commit and release are idempotent and refuse the wrong transition', () => {
    const ledger = new InMemoryLedger();
    const lim = { perOrderCap: usd(10_000), dailyCap: usd(10_000), maxOrdersPerHour: 5 };
    const req = { userId: 'u', amount: usd(100), now: NOW, expiresAt: new Date(NOW.getTime() + MIN), limits: lim, duplicateWindowMs: 10 * MIN };
    const a = ledger.reserve({ ...req, key: 'a', cartHash: 'a' });
    const b = ledger.reserve({ ...req, key: 'b', cartHash: 'b' });
    if (!a.ok || !b.ok) throw new Error('setup');
    expect(ledger.commit(a.reservation.id, NOW).status).toBe('committed');
    expect(ledger.commit(a.reservation.id, NOW).status).toBe('committed');
    expect(() => ledger.release(a.reservation.id, 'oops', NOW)).toThrow(/refund/);
    expect(ledger.release(b.reservation.id, 'void', NOW).status).toBe('released');
    expect(ledger.release(b.reservation.id, 'void', NOW).status).toBe('released');
    expect(ledger.reserve({ ...req, key: 'a', cartHash: 'z' })).toMatchObject({ ok: false, code: 'DUPLICATE_ORDER' });
    expect(ledger.reserve({ ...req, key: 'c', cartHash: 'c', amount: { cents: 100, currency: 'EUR' } })).toMatchObject({
      ok: false,
      code: 'CURRENCY_MISMATCH',
    });
  });
});
