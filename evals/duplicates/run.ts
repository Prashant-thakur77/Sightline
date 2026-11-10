/**
 * Duplicates suite: 100 scripted scenarios in which one purchase is at risk of becoming two.
 * Each runs through the real confirmation state machine (decideConfirmation), the real payment
 * gate (runGate over an InMemoryLedger) and the real request id (gate's
 * paypalRequestId('order', cartHash, readbackId)), into a simulated PayPal that is idempotent on
 * PayPal-Request-Id: the same id returns the original order instead of creating a new one.
 *
 * Two configurations, same scenarios, same timings:
 *   bound     the PayPal-Request-Id is the gate's bound id (what payForReadback sends)
 *   unbound   a fresh random id for every pay attempt (reused only across the HTTP client's own
 *             retries inside one call, as the PayPal client does)
 * Everything else (state machine, gate duplicate guard, reservations) runs in both.
 *
 * Timing model: a discrete-event simulation. A request reads the session's confirmation state
 * when it arrives and writes it when it completes (last writer wins), so overlapping requests can
 * see stale state. Two tabs have independent state (worst case). Simulation of PayPal's
 * documented idempotency; no PayPal call is made.
 */
import { decideConfirmation, initialConfirmationState, matchConfirmationPhrase, type ConfirmationClassifier, type ConfirmationState } from '@sightline/agent';
import type { Cart } from '@sightline/core';
import { runGate, type ConfirmedReadback, type GatePorts, type PaymentIntent } from '@sightline/gate';
import {
  DEMO_SELLER,
  DEMO_SLUGS,
  GATE_OPTS,
  InMemoryLedger,
  demoItem,
  demoProduct,
  freezeSnapshot,
  ledgerPorts,
  makeCart,
  makeReadback,
} from '../lib/commerce';
import { ofN, scriptPath, writeResult, type Headline } from '../lib/results';
import { mulberry32, wilsonText } from '../lib/stats';

const SCRIPT = scriptPath(import.meta.url);
const LABEL = "Simulation of PayPal's documented PayPal-Request-Id idempotency; no PayPal call is made";
const T0 = Date.parse('2026-11-09T16:00:00.000Z');

const key2Stub: ConfirmationClassifier = {
  classify: async (u) =>
    matchConfirmationPhrase(u).decision === 'confirm'
      ? { label: 'confirm', rationale: 'stub: key 1 matched' }
      : { label: 'not_confirm', rationale: 'stub: key 1 did not match' },
};

// ---------------------------------------------------------------------------------------------
// Simulated PayPal: idempotent on PayPal-Request-Id

class SimPayPal {
  private readonly byKey = new Map<string, string>();
  posts = 0;
  replays = 0;
  create(requestId: string): { id: string; replay: boolean } {
    this.posts++;
    const existing = this.byKey.get(requestId);
    if (existing) {
      this.replays++;
      return { id: existing, replay: true };
    }
    const id = `SIM-ORDER-${this.byKey.size + 1}`;
    this.byKey.set(requestId, id);
    return { id, replay: false };
  }
  get distinctOrders(): number {
    return this.byKey.size;
  }
  get distinctRequestIds(): number {
    return this.byKey.size;
  }
}

// ---------------------------------------------------------------------------------------------
// Event loop

class Sim {
  private q: Array<{ t: number; seq: number; run: () => void | Promise<void> }> = [];
  private seq = 0;
  at(t: number, run: () => void | Promise<void>): void {
    this.q.push({ t, seq: this.seq++, run });
  }
  async drain(): Promise<void> {
    while (this.q.length > 0) {
      this.q.sort((a, b) => a.t - b.t || a.seq - b.seq);
      const e = this.q.shift()!;
      await e.run();
    }
  }
}

interface PayPalNet {
  latencyMs: number;
  /** Responses lost (after PayPal created or replayed the order) before one gets through. */
  lostResponses: number;
  httpTimeoutMs: number;
  maxTries: number;
}

interface RequestSpec {
  tab: string;
  readback: string;
  at: number;
  phrase?: string;
  button: boolean;
  classifierMs: number;
  net: PayPalNet;
  /** A buyer who has been told the earlier order went through does not make this request. */
  onlyIfNotToldWentThrough?: boolean;
}

interface Purchase {
  readbackId: string;
  cart: Cart;
  row: ConfirmedReadback;
  createdAt: number;
}

/**
 * What the pay step does when every PayPal response is lost (a network error after the HTTP
 * client's retries, which is ambiguous: PayPal may have created the order).
 *   before_fix  release the hold, mark the order failed, tell the buyer nothing was charged
 *   hold_kept   first fix (payments.ts isAmbiguous): keep the hold, keep the order 'confirmed'
 *               (outcome unknown), tell the buyer the purchase is paused; the duplicate check
 *               still looks back only 10 minutes
 *   current     hold_kept, plus: payForReadback refuses OUTCOME_UNKNOWN while an order of the
 *               same product and variant is still 'confirmed'; gate-ports counts 'confirmed'
 *               orders as recent whatever their age; reconcileUnknownOrders re-sends the original
 *               create with the same PayPal-Request-Id when the buyer comes back
 */
type Policy = 'before_fix' | 'hold_kept' | 'current';
const POLICIES: Policy[] = ['current', 'hold_kept', 'before_fix'];

/** Order statuses the web app's duplicate check counts (PLACED in gate-ports.ts, the ones used here). */
const PLACED_HERE = new Set(['confirmed', 'captured']);

interface LocalOrder {
  status: 'confirmed' | 'captured' | 'failed';
  cartHash: string;
  productId: string;
  variantId: string;
  createdAt: number;
  updatedAt: number;
  reservationId: string;
}

interface World {
  sim: Sim;
  binding: boolean;
  policy: Policy;
  userId: string;
  ledger: InMemoryLedger;
  ports: GatePorts;
  paypal: SimPayPal;
  rng: () => number;
  readbacks: Map<string, Purchase>;
  sessions: Map<string, ConfirmationState>;
  localOrders: Map<string, LocalOrder>;
  stops: { stateMachine: number; gate: Record<string, number>; localOrder: number; paypalReplay: number; unknownOutcomeBlock: number; reconciledOnce: number };
  /** The buyer heard that an earlier order went through after all (reconciliation). */
  toldWentThrough: boolean;
  payAttempts: number;
  trace: string[];
}

function randomRequestId(rng: () => number): string {
  const a = 'abcdefghijklmnopqrstuvwxyz234567';
  let s = '';
  for (let i = 0; i < 36; i++) s += a[Math.floor(rng() * 32)];
  return s;
}

const iso = (t: number) => new Date(T0 + t).toISOString();

function sessionKey(tab: string, readback: string) {
  return `${tab}:${readback}`;
}

function request(w: World, r: RequestSpec): void {
  w.sim.at(r.at, () => {
    if (r.onlyIfNotToldWentThrough && w.toldWentThrough) {
      w.trace.push(`${r.at}ms buyer heard the earlier order went through, so does not buy again`);
      return;
    }
    const p = w.readbacks.get(r.readback)!;
    const key = sessionKey(r.tab, r.readback);
    const seen = w.sessions.get(key) ?? initialConfirmationState(p.row.textHash);
    const decideAt = r.at + (r.phrase ? r.classifierMs : 20);
    w.sim.at(decideAt, async () => {
      const d = await decideConfirmation({
        phrase: r.phrase ?? null,
        classifier: key2Stub,
        buttonPressed: r.button,
        // Spoken while holding Talk; this suite tests duplicates, not the press rule.
        capture: 'held',
        readback: { text: p.row.text, textHash: p.row.textHash, total: p.cart.totals.total },
        state: seen,
        now: T0 + decideAt,
      });
      const persist = (t: number) => w.sim.at(t, () => void w.sessions.set(key, d.state));
      w.trace.push(`${decideAt}ms ${r.tab} ${r.phrase ?? '[button]'} -> ${d.outcome}`);
      if (d.outcome !== 'confirmed') {
        if (d.outcome === 'closed' || d.outcome === 'ignored') w.stops.stateMachine++;
        persist(decideAt + 10);
        return;
      }
      const ev = d.evidence!;
      // Recorded on the shared readback row, as the conductor does.
      p.row.confirmedAt = iso(decideAt);
      p.row.confirmation = {
        phraseMatched: ev.key1.source === 'phrase' || ev.key1.source === 'button',
        classifierAgreed: ev.key2.source === 'classifier' || ev.key2.source === 'second_press',
        utterance: ev.utterance ?? '[Confirm button]',
        at: new Date(ev.key2.at).toISOString(),
      };
      await pay(w, p, decideAt, r.net, persist);
    });
  });
}

/** payForReadback, minus the database: gate, local order by request id, PayPal create with retries. */
async function pay(w: World, p: Purchase, t: number, net: PayPalNet, persist: (t: number) => void): Promise<void> {
  w.payAttempts++;
  const line0 = p.cart.lines[0]!.snapshot;
  if (w.policy === 'current') {
    // payForReadback: an earlier order for the same item whose PayPal outcome is unknown must be settled first.
    const blocked = [...w.localOrders.values()].some((o) => o.status === 'confirmed' && o.productId === line0.productId && o.variantId === line0.variantId);
    if (blocked) {
      w.stops.unknownOutcomeBlock++;
      w.trace.push(`${t}ms pay step refused OUTCOME_UNKNOWN (earlier order for this item not settled)`);
      persist(t + 30);
      return;
    }
  }
  const intent: PaymentIntent = {
    userId: w.userId,
    cart: p.cart,
    readback: { ...p.row },
    payee: { merchantId: DEMO_SELLER.merchantId },
    amount: p.cart.totals.total,
    paymentSource: 'vault',
    intent: 'CAPTURE',
    now: new Date(T0 + t),
  };
  const d = await runGate(intent, w.ports, GATE_OPTS);
  if (!d.allowed) {
    const code = d.firstFailure?.code ?? 'REFUSED';
    w.stops.gate[code] = (w.stops.gate[code] ?? 0) + 1;
    w.trace.push(`${t}ms gate refused ${code}`);
    persist(t + 30);
    return;
  }
  const requestId = w.binding ? d.requestId : randomRequestId(w.rng);
  const existing = w.localOrders.get(requestId);
  if (existing && existing.status === 'captured') {
    w.stops.localOrder++;
    persist(t + 30);
    return;
  }
  const reservation = d.reservation!;
  if (!existing)
    w.localOrders.set(requestId, {
      status: 'confirmed',
      cartHash: p.cart.hash,
      productId: line0.productId,
      variantId: line0.variantId,
      createdAt: t,
      updatedAt: t,
      reservationId: reservation.id,
    });
  const setStatus = (status: LocalOrder['status'], at: number) => {
    const o = w.localOrders.get(requestId)!;
    w.localOrders.set(requestId, { ...o, status, updatedAt: at });
  };
  let lostLeft = net.lostResponses;
  const tryCreate = (k: number, tk: number) => {
    w.sim.at(tk, () => {
      const res = w.paypal.create(requestId);
      if (res.replay) w.stops.paypalReplay++;
      w.trace.push(`${tk}ms paypal create ${requestId.slice(0, 6)} -> ${res.id}${res.replay ? ' (replay)' : ''}${lostLeft > 0 ? ' [response lost]' : ''}`);
      if (lostLeft > 0) {
        lostLeft--;
        if (k + 1 < net.maxTries) tryCreate(k + 1, tk + net.httpTimeoutMs + 250 * 2 ** k);
        else
          w.sim.at(tk + net.httpTimeoutMs, () => {
            if (w.policy === 'before_fix') {
              w.ledger.release(reservation.id, 'paypal_error', new Date(T0 + tk + net.httpTimeoutMs));
              setStatus('failed', tk + net.httpTimeoutMs);
              w.trace.push(`${tk + net.httpTimeoutMs}ms pay step gave up; hold released; buyer told nothing was charged`);
            } else {
              setStatus('confirmed', tk + net.httpTimeoutMs);
              w.trace.push(`${tk + net.httpTimeoutMs}ms pay step gave up; outcome unknown; hold and order kept; buyer told the purchase is paused`);
            }
          });
        return;
      }
      w.sim.at(tk + net.latencyMs, () => {
        w.ledger.commit(reservation.id, new Date(T0 + tk + net.latencyMs));
        setStatus('captured', tk + net.latencyMs);
      });
    });
  };
  tryCreate(0, t + 50);
  persist(t + 50 + payDuration(net));
}

/** When the pay step finishes, from the network parameters (same formula as tryCreate). */
export function payDuration(net: PayPalNet): number {
  let t = 0;
  const lost = Math.min(net.lostResponses, net.maxTries);
  for (let k = 0; k < lost; k++) t += net.httpTimeoutMs + (k + 1 < net.maxTries ? 250 * 2 ** k : 0);
  if (lost >= net.maxTries) return t;
  return t + net.latencyMs;
}

// ---------------------------------------------------------------------------------------------
// Scenarios

type Family =
  | 'double_click'
  | 'triple_confirmation'
  | 'retry_same_confirmation'
  | 'retry_fresh_readback'
  | 'confirm_then_resay'
  | 'two_tabs'
  | 'rebuy_after_window'
  | 'comeback_after_window';

interface Scenario {
  id: string;
  family: Family;
  product: string;
  description: string;
  /** Extra readbacks created mid-scenario (fresh readback after a failure). */
  laterReadbacks: Array<{ id: string; at: number; onlyIfNotToldWentThrough?: boolean }>;
  /** Times the buyer comes back (session start), which runs reconcileUnknownOrders under the current policy. */
  sessionStarts?: number[];
  requests: RequestSpec[];
}

const between = (rng: () => number, lo: number, hi: number) => Math.round(lo + rng() * (hi - lo));
const okNet = (rng: () => number): PayPalNet => ({ latencyMs: between(rng, 600, 2500), lostResponses: 0, httpTimeoutMs: 4000, maxTries: 3 });

function buildScenarios(): Scenario[] {
  const out: Scenario[] = [];
  const RB = 'rb_main';
  for (let i = 0; i < 20; i++) {
    const rng = mulberry32(1000 + i);
    const product = DEMO_SLUGS[i % DEMO_SLUGS.length]!;

    // 1. Double-click within 300 ms on the second press of the Confirm button.
    {
      const first = 0;
      const t1 = between(rng, 800, 3000);
      const delta = between(rng, 30, 300);
      out.push({
        id: `double_click-${i + 1}`,
        family: 'double_click',
        product,
        description: `Press Confirm, then double-click it ${t1} ms later (${delta} ms apart).`,
        laterReadbacks: [],
        requests: [
          { tab: 'A', readback: RB, at: first, button: true, classifierMs: 0, net: okNet(rng) },
          { tab: 'A', readback: RB, at: t1, button: true, classifierMs: 0, net: okNet(rng) },
          { tab: 'A', readback: RB, at: t1 + delta, button: true, classifierMs: 0, net: okNet(rng) },
        ],
      });
    }

    // 2. Triple confirmation: "confirm purchase" three times in a row.
    {
      const g1 = between(rng, 300, 2500);
      const g2 = between(rng, 300, 2500);
      const phrases = ['confirm purchase', 'confirm purchase', 'confirm purchase'];
      out.push({
        id: `triple_confirmation-${i + 1}`,
        family: 'triple_confirmation',
        product,
        description: `"confirm purchase" three times, ${g1} ms then ${g2} ms apart.`,
        laterReadbacks: [],
        requests: [0, g1, g1 + g2].map((at, k) => ({ tab: 'A', readback: RB, at, phrase: phrases[k], button: false, classifierMs: between(rng, 300, 1200), net: okNet(rng) })),
      });
    }

    // 3a. Network retry after a timeout, same confirmation (10 scenarios).
    // 3b. Same lost response, then the buyer starts again on a fresh readback (10 scenarios).
    {
      const c1 = between(rng, 300, 1200);
      const net1: PayPalNet = { latencyMs: between(rng, 600, 2500), lostResponses: 3, httpTimeoutMs: between(rng, 3000, 6000), maxTries: 3 };
      const giveUpAt = c1 + 50 + payDuration(net1);
      if (i < 10) {
        // The browser's resend reads state before the first request finishes and reaches the gate just after the hold is released.
        const c2 = between(rng, 400, 1200);
        const resendAt = giveUpAt - Math.round(c2 * (0.2 + 0.6 * rng()));
        out.push({
          id: `retry_same_confirmation-${i + 1}`,
          family: 'retry_same_confirmation',
          product,
          description: `Every PayPal response to the first create is lost (${net1.maxTries} tries, ${net1.httpTimeoutMs} ms timeout; PayPal did create the order). The pay step gives up at ${giveUpAt} ms; the browser re-sends the confirmation at ${resendAt} ms and its gate check lands just after that.`,
          laterReadbacks: [],
          requests: [
            { tab: 'A', readback: RB, at: 0, phrase: 'confirm purchase', button: false, classifierMs: c1, net: net1 },
            { tab: 'A', readback: RB, at: resendAt, phrase: 'confirm purchase', button: false, classifierMs: c2, net: okNet(rng) },
          ],
        });
      } else {
        const wait = between(rng, 3000, 20000);
        const rb2At = giveUpAt + wait;
        const confirmAt = rb2At + between(rng, 8000, 30000);
        out.push({
          id: `retry_fresh_readback-${i - 9}`,
          family: 'retry_fresh_readback',
          product,
          description: `Every PayPal response is lost; ${wait} ms after the pay step gives up the buyer says "buy it" again and confirms the new readback.`,
          laterReadbacks: [{ id: 'rb_again', at: rb2At }],
          requests: [
            { tab: 'A', readback: RB, at: 0, phrase: 'confirm purchase', button: false, classifierMs: c1, net: net1 },
            { tab: 'A', readback: 'rb_again', at: confirmAt, phrase: 'confirm purchase', button: false, classifierMs: between(rng, 300, 1200), net: okNet(rng) },
          ],
        });
      }
    }

    // 4. Confirm, then say confirm again (half while the first request is still running).
    {
      const c1 = between(rng, 300, 1200);
      const net1 = okNet(rng);
      const inFlight = i % 2 === 0;
      const gap = inFlight ? between(rng, 200, c1 + net1.latencyMs) : between(rng, c1 + net1.latencyMs + 500, 30000);
      const again = ['confirm', 'confirm purchase', 'yes, confirm', 'confirm it', 'buy it now'][i % 5]!;
      out.push({
        id: `confirm_then_resay-${i + 1}`,
        family: 'confirm_then_resay',
        product,
        description: `"confirm purchase", then "${again}" ${gap} ms later (${inFlight ? 'while the first is still running' : 'after it finished'}).`,
        laterReadbacks: [],
        requests: [
          { tab: 'A', readback: RB, at: 0, phrase: 'confirm purchase', button: false, classifierMs: c1, net: net1 },
          { tab: 'A', readback: RB, at: gap, phrase: again, button: false, classifierMs: between(rng, 300, 1200), net: okNet(rng) },
        ],
      });
    }

    // 5. Two tabs on the same readback, each with its own confirmation state.
    {
      const gap = i < 10 ? between(rng, 200, 3000) : between(rng, 3000, 210000);
      const byButton = i % 3 === 2;
      const tabB: RequestSpec[] = byButton
        ? [
            { tab: 'B', readback: RB, at: gap, button: true, classifierMs: 0, net: okNet(rng) },
            { tab: 'B', readback: RB, at: gap + 900, button: true, classifierMs: 0, net: okNet(rng) },
          ]
        : [{ tab: 'B', readback: RB, at: gap, phrase: 'confirm purchase', button: false, classifierMs: between(rng, 300, 1200), net: okNet(rng) }];
      out.push({
        id: `two_tabs-${i + 1}`,
        family: 'two_tabs',
        product,
        description: `Confirmed in tab A, then in tab B ${gap} ms later${byButton ? ' with two presses' : ''}.`,
        laterReadbacks: [],
        requests: [{ tab: 'A', readback: RB, at: 0, phrase: 'confirm purchase', button: false, classifierMs: between(rng, 300, 1200), net: okNet(rng) }, ...tabB],
      });
    }
  }
  return out;
}

/**
 * Separate probe, not part of the 100: the PayPal answer is lost, and the buyer buys the same item
 * again after the 10-minute duplicate window. Two buyer paths over the same timings:
 *   rebuy_after_window     the buyer stays in the session and buys again
 *   comeback_after_window  the buyer comes back first (session start, which runs reconciliation
 *                          under the current policy), then buys again only if not told the earlier
 *                          order went through
 */
function buildAfterWindowProbe(): { stay: Scenario[]; comeBack: Scenario[] } {
  const stay: Scenario[] = [];
  const comeBack: Scenario[] = [];
  for (let j = 0; j < 10; j++) {
    const rng = mulberry32(2000 + j);
    const c1 = between(rng, 300, 1200);
    const net1: PayPalNet = { latencyMs: between(rng, 600, 2500), lostResponses: 3, httpTimeoutMs: between(rng, 3000, 6000), maxTries: 3 };
    const giveUpAt = c1 + 50 + payDuration(net1);
    const rebuyAt = giveUpAt + between(rng, 10.5 * 60_000, 20 * 60_000);
    const confirmAt = rebuyAt + between(rng, 8000, 30000);
    const c2 = between(rng, 300, 1200);
    const product = DEMO_SLUGS[j % DEMO_SLUGS.length]!;
    const first: RequestSpec = { tab: 'A', readback: 'rb_main', at: 0, phrase: 'confirm purchase', button: false, classifierMs: c1, net: net1 };
    const again = (onlyIf: boolean): RequestSpec => ({
      tab: 'A',
      readback: 'rb_again',
      at: confirmAt,
      phrase: 'confirm purchase',
      button: false,
      classifierMs: c2,
      net: { ...net1, lostResponses: 0 },
      ...(onlyIf ? { onlyIfNotToldWentThrough: true } : {}),
    });
    const gap = Math.round((rebuyAt - giveUpAt) / 1000);
    stay.push({
      id: `rebuy_after_window-${j + 1}`,
      family: 'rebuy_after_window',
      product,
      description: `Every PayPal response is lost; ${gap} s later, in the same session, the buyer says "buy it" again and confirms the new readback.`,
      laterReadbacks: [{ id: 'rb_again', at: rebuyAt }],
      requests: [first, again(false)],
    });
    comeBack.push({
      id: `comeback_after_window-${j + 1}`,
      family: 'comeback_after_window',
      product,
      description: `Every PayPal response is lost; ${gap} s later the buyer comes back (session start), then says "buy it" again unless told the earlier order went through.`,
      laterReadbacks: [{ id: 'rb_again', at: rebuyAt, onlyIfNotToldWentThrough: true }],
      sessionStarts: [rebuyAt - 5000],
      requests: [first, again(true)],
    });
  }
  return { stay, comeBack };
}

function makePurchase(userId: string, readbackId: string, cartId: string, snap: ReturnType<typeof freezeSnapshot>, createdAt: number): Purchase {
  const cart = makeCart(userId, [{ snapshot: snap, quantity: 1 }], cartId, new Date(T0 + createdAt - 10_000));
  const row = makeReadback(cart, readbackId, new Date(T0 + createdAt));
  return { readbackId, cart, row, createdAt };
}

/** apps/web/src/server/conductor.ts freshSnapshot: a snapshot younger than this is reused for a new readback. */
const SNAPSHOT_REUSE_MS = 12 * 60_000;
const SNAPSHOT_AT = -120_000;
/** reconcileUnknownOrders skips orders updated less than this long ago. */
const RECONCILE_MIN_AGE_MS = 20_000;

/**
 * reconcileUnknownOrders: for each order still 'confirmed' (and not touched in the last 20 s),
 * re-send the create with the order's own PayPal-Request-Id. The network is healthy by now, so
 * PayPal answers; it returns the original order if it created one.
 */
function reconcile(w: World, t: number): void {
  for (const [requestId, o] of w.localOrders) {
    if (o.status !== 'confirmed' || t - o.updatedAt < RECONCILE_MIN_AGE_MS) continue;
    const res = w.paypal.create(requestId);
    if (res.replay) w.stops.paypalReplay++;
    w.ledger.commit(o.reservationId, new Date(T0 + t));
    w.localOrders.set(requestId, { ...o, status: 'captured', updatedAt: t });
    w.stops.reconciledOnce++;
    w.toldWentThrough = true;
    w.trace.push(`${t}ms buyer came back; reconciliation re-sent ${requestId.slice(0, 6)} -> ${res.id}${res.replay ? ' (replay)' : ''}; settled once; buyer told it went through`);
  }
}

async function runScenario(s: Scenario, binding: boolean, policy: Policy, seed: number) {
  const ledger = new InMemoryLedger();
  const userId = `user_dup_${s.id}`;
  const item = demoItem(s.product);
  const selection: Record<string, string> = { Colour: item.colours[0]! };
  if (item.sizes?.includes('M')) selection.Size = 'M';
  const product = demoProduct(s.product, selection);
  const snap = freezeSnapshot(product, new Date(T0 + SNAPSHOT_AT), `snap_${s.id}`);
  const base = ledgerPorts(ledger);
  const w: World = {
    sim: new Sim(),
    binding,
    policy,
    userId,
    ledger,
    ports: base,
    paypal: new SimPayPal(),
    rng: mulberry32(seed),
    readbacks: new Map(),
    sessions: new Map(),
    localOrders: new Map(),
    stops: { stateMachine: 0, gate: {}, localOrder: 0, paypalReplay: 0, unknownOutcomeBlock: 0, reconciledOnce: 0 },
    toldWentThrough: false,
    payAttempts: 0,
    trace: [],
  };
  // As gate-ports.ts: orders already placed for this cart hash count; failed ones do not. Under the
  // current policy an order whose outcome is unknown ('confirmed') counts whatever its age.
  w.ports = {
    ...base,
    recentOrdersForCart: (hash, sinceMs) => [
      ...ledger.recentOrdersForCart(hash, sinceMs),
      ...[...w.localOrders.entries()]
        .filter(
          ([, o]) =>
            o.cartHash === hash &&
            PLACED_HERE.has(o.status) &&
            (T0 + o.createdAt >= sinceMs || (w.policy === 'current' && o.status === 'confirmed')),
        )
        .map(([key, o]) => ({
          id: `order_${key.slice(0, 8)}`,
          cartHash: hash,
          createdAt: w.policy === 'current' && o.status === 'confirmed' ? new Date(Math.max(sinceMs, T0 + o.createdAt)).toISOString() : iso(o.createdAt),
          status: o.status === 'captured' ? ('captured' as const) : ('confirmed' as const),
        })),
    ],
  };
  w.readbacks.set('rb_main', makePurchase(userId, `rb_${s.id}`, `cart_${s.id}`, snap, -60_000));
  for (const later of s.laterReadbacks) {
    // The buyer says "buy it" again: a new cart and readback; the snapshot is reused only while young.
    w.sim.at(later.at, () => {
      if (later.onlyIfNotToldWentThrough && w.toldWentThrough) return;
      const reuse = later.at - SNAPSHOT_AT < SNAPSHOT_REUSE_MS;
      const useSnap = reuse ? snap : freezeSnapshot(product, new Date(T0 + later.at), `snap_${s.id}_${later.id}`);
      w.trace.push(`${later.at}ms new readback ${later.id} (${reuse ? 'snapshot reused' : 'snapshot re-taken'})`);
      w.readbacks.set(later.id, makePurchase(userId, `rb_${s.id}_${later.id}`, `cart_${s.id}_${later.id}`, useSnap, later.at));
    });
  }
  for (const t of s.sessionStarts ?? []) {
    w.sim.at(t, () => {
      if (w.policy === 'current') reconcile(w, t);
      else w.trace.push(`${t}ms buyer came back; no reconciliation under this policy`);
    });
  }
  for (const r of s.requests) request(w, r);
  await w.sim.drain();
  return {
    paypalOrders: w.paypal.distinctOrders,
    paypalPosts: w.paypal.posts,
    payAttempts: w.payAttempts,
    stops: w.stops,
    trace: w.trace,
  };
}

type Mode = 'bound' | 'unbound';
type Run = Awaited<ReturnType<typeof runScenario>>;

function emptyAgg() {
  return {
    orders: 0,
    dupScenarios: 0,
    posts: 0,
    payAttempts: 0,
    stops: { stateMachine: 0, gate: 0, localOrder: 0, paypalReplay: 0, unknownOutcomeBlock: 0, reconciledOnce: 0 },
    gateCodes: {} as Record<string, number>,
  };
}

function addTo(a: ReturnType<typeof emptyAgg>, r: Run): void {
  a.orders += r.paypalOrders;
  if (r.paypalOrders > 1) a.dupScenarios++;
  a.posts += r.paypalPosts;
  a.payAttempts += r.payAttempts;
  a.stops.stateMachine += r.stops.stateMachine;
  a.stops.localOrder += r.stops.localOrder;
  a.stops.paypalReplay += r.stops.paypalReplay;
  a.stops.unknownOutcomeBlock += r.stops.unknownOutcomeBlock;
  a.stops.reconciledOnce += r.stops.reconciledOnce;
  for (const [code, n] of Object.entries(r.stops.gate)) {
    a.stops.gate += n;
    a.gateCodes[code] = (a.gateCodes[code] ?? 0) + n;
  }
}

type Agg = Record<Policy, Record<Mode, ReturnType<typeof emptyAgg>>>;
type FamilyCounts = { n: number } & Record<Policy, Record<Mode, number>>;

async function runAll(scenarios: Scenario[], seedBase: number) {
  const agg = Object.fromEntries(POLICIES.map((p) => [p, { bound: emptyAgg(), unbound: emptyAgg() }])) as Agg;
  const byFamily: Record<string, FamilyCounts> = {};
  const rows: Array<Record<string, unknown>> = [];
  for (const [i, s] of scenarios.entries()) {
    const f = (byFamily[s.family] ??= { n: 0, ...(Object.fromEntries(POLICIES.map((p) => [p, { bound: 0, unbound: 0 }])) as Record<Policy, Record<Mode, number>>) });
    f.n++;
    const row: Record<string, unknown> = { id: s.id, family: s.family, product: s.product, description: s.description };
    for (const policy of POLICIES) {
      const out: Record<string, unknown> = {};
      for (const mode of ['bound', 'unbound'] as const) {
        const r = await runScenario(s, mode === 'bound', policy, seedBase + i);
        if (r.paypalOrders === 0) throw new Error(`Scenario ${s.id} placed no order at all; the script is wrong`);
        addTo(agg[policy][mode], r);
        if (r.paypalOrders > 1) f[policy][mode]++;
        out[mode] = { paypalOrders: r.paypalOrders, paypalPosts: r.paypalPosts, payAttempts: r.payAttempts, stops: r.stops, ...(mode === 'bound' ? { trace: r.trace } : {}) };
      }
      row[policy] = out;
    }
    rows.push(row);
  }
  return { agg, byFamily, rows };
}

async function main() {
  const scenarios = buildScenarios();
  const main100 = await runAll(scenarios, 50_000);
  const probeSets = buildAfterWindowProbe();
  const stay = await runAll(probeSets.stay, 60_000);
  const comeBack = await runAll(probeSets.comeBack, 60_000);

  const N = scenarios.length;
  const C = main100.agg.current;
  const B = main100.agg.before_fix;
  const fam = (f: Family) => main100.byFamily[f]!;
  const repeatFamilies: Family[] = ['double_click', 'triple_confirmation', 'retry_same_confirmation', 'confirm_then_resay', 'two_tabs'];
  const sumFam = (policy: Policy, mode: Mode) => repeatFamilies.reduce((a, f) => a + fam(f)[policy][mode], 0);
  const repeatN = repeatFamilies.reduce((a, f) => a + fam(f).n, 0);
  const same = fam('retry_same_confirmation');
  const fresh = fam('retry_fresh_readback');
  const late = stay.byFamily.rebuy_after_window!;
  const back = comeBack.byFamily.comeback_after_window!;
  const backSettled = comeBack.agg.current.bound.stops.reconciledOnce;

  const headlines: Headline[] = [
    {
      id: 'duplicate-scenarios',
      label: 'Scenarios that end with more than one PayPal order (100 duplicate-prone scenarios, current payment policy)',
      value: ofN(C.bound.dupScenarios, N),
      baseline: `random request id per attempt: ${ofN(C.unbound.dupScenarios, N)}`,
      interval: wilsonText(C.bound.dupScenarios, N),
      n: N,
      script: SCRIPT,
      note: `${LABEL}. ${C.bound.orders} orders for ${N} intended purchases. Before the fix for lost PayPal answers: ${ofN(B.bound.dupScenarios, N)} (random id: ${ofN(B.unbound.dupScenarios, N)}).`,
    },
    {
      id: 'duplicate-scenarios-before-fix',
      label: 'Same 100 scenarios before the fix (lost PayPal answer released the hold and the buyer heard "nothing was charged")',
      value: ofN(B.bound.dupScenarios, N),
      baseline: `random request id per attempt: ${ofN(B.unbound.dupScenarios, N)}`,
      interval: wilsonText(B.bound.dupScenarios, N),
      n: N,
      script: SCRIPT,
      negative: B.bound.dupScenarios > 0,
      note: `Before fix, kept for comparison. ${B.bound.orders} orders for ${N} intended purchases.`,
    },
    {
      id: 'duplicate-repeats',
      label: 'Repeats of one confirmation (double-click, triple confirm, resend after timeout, re-say, two tabs) that end in a second order',
      value: ofN(sumFam('current', 'bound'), repeatN),
      baseline: `random request id per attempt: ${ofN(sumFam('current', 'unbound'), repeatN)}`,
      interval: wilsonText(sumFam('current', 'bound'), repeatN),
      n: repeatN,
      script: SCRIPT,
      note: `${LABEL}. Before the fix: ${ofN(sumFam('before_fix', 'bound'), repeatN)} (random id: ${ofN(sumFam('before_fix', 'unbound'), repeatN)}).`,
    },
    {
      id: 'duplicate-resend-after-timeout',
      label: 'Resend after a lost PayPal response, same confirmation: second order created',
      value: ofN(same.current.bound, same.n),
      baseline: `random request id per attempt: ${ofN(same.current.unbound, same.n)}`,
      interval: wilsonText(same.current.bound, same.n),
      n: same.n,
      script: SCRIPT,
      note: `Before the fix: ${ofN(same.before_fix.bound, same.n)} with the bound id, ${ofN(same.before_fix.unbound, same.n)} with a random id, so the bound id alone stopped it. Now the resend is refused before any new PayPal call.`,
    },
    {
      id: 'duplicate-fresh-readback',
      label: 'Lost PayPal response, buyer buys again on a new readback within minutes: second order created',
      value: ofN(fresh.current.bound, fresh.n),
      baseline: `random request id per attempt: ${ofN(fresh.current.unbound, fresh.n)}`,
      interval: wilsonText(fresh.current.bound, fresh.n),
      n: fresh.n,
      script: SCRIPT,
      negative: fresh.current.bound > 0,
      note: `Before the fix: ${ofN(fresh.before_fix.bound, fresh.n)} (random id: ${ofN(fresh.before_fix.unbound, fresh.n)}). Now refused while the earlier order's outcome is unknown.`,
    },
    {
      id: 'duplicate-after-window',
      label: 'Lost PayPal response, buyer buys the same item again after the 10-minute duplicate window: second order created',
      value: ofN(late.current.bound, late.n),
      baseline: `random request id per attempt: ${ofN(late.current.unbound, late.n)}`,
      interval: wilsonText(late.current.bound, late.n),
      n: late.n,
      script: SCRIPT,
      negative: late.current.bound > 0,
      note: `Separate probe, not in the 100. Now refused (OUTCOME_UNKNOWN) while the earlier order is unsettled, with no time limit. Before this fix (hold kept, 10-minute look-back only): ${ofN(late.hold_kept.bound, late.n)}.`,
    },
    {
      id: 'duplicate-after-window-before',
      label: 'Same probe before the unknown-outcome block (hold kept, duplicate check looks back 10 minutes only)',
      value: ofN(late.hold_kept.bound, late.n),
      baseline: `random request id per attempt: ${ofN(late.hold_kept.unbound, late.n)}`,
      interval: wilsonText(late.hold_kept.bound, late.n),
      n: late.n,
      script: SCRIPT,
      negative: late.hold_kept.bound > 0,
      note: 'Before fix, kept for comparison: a snapshot older than 12 minutes is re-taken (new cart hash) and the look-back had ended.',
    },
    {
      id: 'reconcile-on-return',
      label: 'Buyer comes back after a lost PayPal response, then would buy again: second order created',
      value: ofN(back.current.bound, back.n),
      baseline: `before reconciliation existed: ${ofN(back.hold_kept.bound, back.n)}`,
      interval: wilsonText(back.current.bound, back.n),
      n: back.n,
      script: SCRIPT,
      negative: back.current.bound > 0,
      note: `Reconciliation re-sent the original request id; PayPal returned the original order and it was settled once in ${ofN(backSettled, back.n)}. The simulated buyer, told it went through, does not buy again.`,
    },
  ];

  const limitations = [
    `${LABEL}. Assumes the documented behaviour that a repeated PayPal-Request-Id returns the original order, and that every retry falls inside PayPal's key-retention window. The PayPal sandbox run needs PayPal keys.`,
    'Current policy modelled from apps/web/src/server/payments.ts and gate-ports.ts: when every PayPal response is lost after the gate passed, the hold is kept and the order stays "confirmed"; a new purchase of the same product and variant is refused (OUTCOME_UNKNOWN) while it is unsettled; the duplicate check counts it whatever its age; reconcileUnknownOrders re-sends the original create when the buyer comes back. "Before" rows replay the same scenarios with the earlier behaviour. Definite 4xx failures, which still release the hold, are not exercised.',
    'Reconciliation is modelled for saved-PayPal (vault) orders only, as the code does; an unknown-outcome order paid through the PayPal popup is never reconciled and keeps that item blocked. In every simulated lost response PayPal had created the order; a request that never reached PayPal was not modelled.',
    'Timings are scripted per family with seeded random gaps. The resend-after-timeout race is placed on purpose so the resend reaches the gate just after the first attempt gives up.',
    'Session state is modelled as read on arrival and written on completion, last writer wins; two tabs get independent state (worst case). The web app\'s real session store and database were not exercised; the duplicate check reads simulated orders the way gate-ports.ts reads the orders table.',
    'Key 2 is a stub that agrees exactly when key 1 does; the real classifier needs ANTHROPIC_API_KEY.',
    'The random-id baseline only changes the id sent to PayPal. The gate\'s own duplicate guard and reservations run in both configurations.',
  ];

  const totals = (agg: Agg, n: number) =>
    Object.fromEntries(
      POLICIES.map((p) => [
        p,
        { bound: { ...agg[p].bound, extraOrders: agg[p].bound.orders - n }, unbound: { ...agg[p].unbound, extraOrders: agg[p].unbound.orders - n } },
      ]),
    );

  writeResult('duplicates', {
    title: 'Duplicate orders',
    headlines,
    limitations,
    details: {
      label: LABEL,
      requestId: "paypalRequestId('order', cart.hash, readback.id), computed by runGate (orderRequestId)",
      configurations: {
        bound: "PayPal-Request-Id = the gate's bound id",
        unbound: 'PayPal-Request-Id = fresh random id per pay attempt, reused only across the HTTP client\'s own retries in one call',
        current:
          'Lost PayPal answer: hold kept, order stays confirmed (outcome unknown); same product+variant refused (OUTCOME_UNKNOWN) until settled; unknown orders count as recent duplicates at any age; reconciliation on return re-sends the original request id',
        hold_kept: 'Lost PayPal answer: hold kept, order stays confirmed; duplicate check looks back 10 minutes only; no reconciliation',
        before_fix: 'Lost PayPal answer: hold released, order failed, buyer told nothing was charged',
      },
      totals: { scenarios: N, intendedPurchases: N, ...totals(main100.agg, N) },
      byFamily: main100.byFamily,
      afterWindowProbe: {
        sameSession: { n: late.n, byPolicy: late, totals: totals(stay.agg, late.n), scenarios: stay.rows },
        buyerComesBack: { n: back.n, byPolicy: back, settledOnceByReconciliation: backSettled, totals: totals(comeBack.agg, back.n), scenarios: comeBack.rows },
      },
      whatStoppedRepeats:
        'stateMachine: a repeat that reached a confirmed or awaiting state was closed or ignored; unknownOutcomeBlock: payForReadback refused OUTCOME_UNKNOWN; gate: runGate refused (codes listed); localOrder: same request id already captured locally; paypalReplay: PayPal returned the original order for a repeated request id; reconciledOnce: an unknown order settled by reconciliation.',
      scenarios: main100.rows,
    },
  });

  for (const p of POLICIES) {
    const a = main100.agg[p];
    console.log(`duplicates (${p}): bound ${ofN(a.bound.dupScenarios, N)} scenarios with >1 order (${a.bound.orders} orders), random id ${ofN(a.unbound.dupScenarios, N)} (${a.unbound.orders} orders)`);
  }
  console.log(`after-window probe, same session: current ${ofN(late.current.bound, late.n)} (random ${ofN(late.current.unbound, late.n)}); hold_kept ${ofN(late.hold_kept.bound, late.n)}; before_fix ${ofN(late.before_fix.bound, late.n)}`);
  console.log(`after-window probe, buyer comes back: current ${ofN(back.current.bound, back.n)} (random ${ofN(back.current.unbound, back.n)}), settled once ${backSettled}; hold_kept ${ofN(back.hold_kept.bound, back.n)}`);
  console.log(JSON.stringify(main100.byFamily));
  console.log('current, bound stops', JSON.stringify(C.bound.stops), JSON.stringify(C.bound.gateCodes));
}

await main();
