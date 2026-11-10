/**
 * The duplicate-order scenarios and the buyer side of the simulation, shared by the local run
 * (run.ts, simulated PayPal) and the sandbox-ledger run (sandbox.ts, the real PayPal sandbox):
 * scenario builders, the discrete-event clock, and a confirmation request through the real
 * two-key state machine. What happens after the buyer confirms (the pay step) is passed in.
 */
import { decideConfirmation, initialConfirmationState, matchConfirmationPhrase, type ConfirmationClassifier, type ConfirmationState } from '@sightline/agent';
import type { Cart } from '@sightline/core';
import type { ConfirmedReadback } from '@sightline/gate';
import { DEMO_SLUGS, freezeSnapshot, makeCart, makeReadback } from '../lib/commerce';
import { mulberry32 } from '../lib/stats';

export const T0 = Date.parse('2026-11-09T16:00:00.000Z');

export const key2Stub: ConfirmationClassifier = {
  classify: async (u) =>
    matchConfirmationPhrase(u).decision === 'confirm'
      ? { label: 'confirm', rationale: 'stub: key 1 matched' }
      : { label: 'not_confirm', rationale: 'stub: key 1 did not match' },
};

// ---------------------------------------------------------------------------------------------
// Event loop

export class Sim {
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

export interface PayPalNet {
  latencyMs: number;
  /** Responses lost (after PayPal created or replayed the order) before one gets through. */
  lostResponses: number;
  httpTimeoutMs: number;
  maxTries: number;
}

export interface RequestSpec {
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

export interface Purchase {
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
export type Policy = 'before_fix' | 'hold_kept' | 'current';
export const POLICIES: Policy[] = ['current', 'hold_kept', 'before_fix'];

export function randomRequestId(rng: () => number): string {
  const a = 'abcdefghijklmnopqrstuvwxyz234567';
  let s = '';
  for (let i = 0; i < 36; i++) s += a[Math.floor(rng() * 32)];
  return s;
}

export const iso = (t: number) => new Date(T0 + t).toISOString();

export function sessionKey(tab: string, readback: string) {
  return `${tab}:${readback}`;
}

/** What request() needs from a run's world. */
export interface RequestWorld {
  sim: Sim;
  readbacks: Map<string, Purchase>;
  sessions: Map<string, ConfirmationState>;
  stops: { stateMachine: number };
  /** The buyer heard that an earlier order went through after all (reconciliation). */
  toldWentThrough: boolean;
  trace: string[];
}

export type PayFn<W> = (w: W, p: Purchase, t: number, net: PayPalNet, persist: (t: number) => void) => Promise<void>;

export function request<W extends RequestWorld>(w: W, r: RequestSpec, pay: PayFn<W>): void {
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

export type Family =
  | 'double_click'
  | 'triple_confirmation'
  | 'retry_same_confirmation'
  | 'retry_fresh_readback'
  | 'confirm_then_resay'
  | 'two_tabs'
  | 'rebuy_after_window'
  | 'comeback_after_window';

export interface Scenario {
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

export const between = (rng: () => number, lo: number, hi: number) => Math.round(lo + rng() * (hi - lo));
export const okNet = (rng: () => number): PayPalNet => ({ latencyMs: between(rng, 600, 2500), lostResponses: 0, httpTimeoutMs: 4000, maxTries: 3 });

export function buildScenarios(): Scenario[] {
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
export function buildAfterWindowProbe(): { stay: Scenario[]; comeBack: Scenario[] } {
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

export function makePurchase(userId: string, readbackId: string, cartId: string, snap: ReturnType<typeof freezeSnapshot>, createdAt: number, opts: { payAfterCheck?: boolean } = {}): Purchase {
  const cart = makeCart(userId, [{ snapshot: snap, quantity: 1 }], cartId, new Date(T0 + createdAt - 10_000));
  const row = makeReadback(cart, readbackId, new Date(T0 + createdAt), opts);
  return { readbackId, cart, row, createdAt };
}

/** apps/web/src/server/conductor.ts freshSnapshot: a snapshot younger than this is reused for a new readback. */
export const SNAPSHOT_REUSE_MS = 12 * 60_000;
export const SNAPSHOT_AT = -120_000;
/** reconcileUnknownOrders skips orders updated less than this long ago. */
export const RECONCILE_MIN_AGE_MS = 20_000;
