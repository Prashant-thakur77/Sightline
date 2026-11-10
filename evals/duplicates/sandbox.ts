/**
 * Duplicates suite, sandbox ledger: the same 100 duplicate-prone scenarios as run.ts (and its
 * after-window probe), with the real PayPal sandbox in place of the simulated PayPal, counted from
 * PayPal's own records.
 *
 * The buyer side is the local run's: the scripted timings on a virtual clock, the real two-key
 * state machine, the real runGate over the gate's InMemoryLedger, and the current payment policy
 * from apps/web/src/server/payments.ts (an earlier order for the same item whose PayPal outcome is
 * unknown blocks a new purchase; an unknown outcome keeps the hold; reconciliation re-sends the
 * original create when the buyer comes back). Every pay step calls the PayPal half of
 * payForReadback for real: orderInputFromCart, createVaultOrder with the gate's PayPal-Request-Id
 * and the sandbox demo buyer's saved PayPal, then completeOrder (authorize, never capture).
 *
 * A lost PayPal response is simulated only at the network edge: the create reaches PayPal, PayPal
 * answers, and the answer is dropped before the client sees it (NetworkEdge.dropCreates). The HTTP
 * client retries with the same PayPal-Request-Id, as in production.
 *
 * After each scenario: GET every PayPal order the scenario's requests created (ids from PayPal's
 * answers at the network edge, dropped answers included) and each authorization, count a duplicate
 * when one confirmation produced more than one PayPal order or authorization, then void every
 * authorization.
 *
 * Baseline (lost-response scenarios only): the policy before the fix (a lost answer released the
 * hold and the buyer heard nothing was charged), with the gate's bound request id and with a
 * fresh random id per attempt.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ConfirmationState } from '@sightline/agent';
import { runGate, type GatePorts, type PaymentIntent } from '@sightline/gate';
import { PayPalApiError, isAmbiguous } from '@sightline/paypal';
import { InMemoryLedger, demoItem, demoProduct, freezeSnapshot, ledgerPorts } from '../lib/commerce';
import { REPO_ROOT, ofN, scriptPath, writeResult, type Headline } from '../lib/results';
import {
  ledgerBreaches,
  payConfirmedReadback,
  readLedger,
  sandboxContext,
  termsFromReadback,
  transactionSearchCheck,
  voidAll,
  type LedgerOrder,
  type SandboxContext,
  type VoidResult,
} from '../lib/sandbox-ledger';
import { mulberry32, wilsonText } from '../lib/stats';
import {
  RECONCILE_MIN_AGE_MS,
  SNAPSHOT_AT,
  SNAPSHOT_REUSE_MS,
  Sim,
  T0,
  buildAfterWindowProbe,
  buildScenarios,
  iso,
  makePurchase,
  payDuration,
  randomRequestId,
  request,
  type Family,
  type PayFn,
  type Policy,
  type Purchase,
  type RequestWorld,
  type Scenario,
} from './scenarios';

const SCRIPT = scriptPath(import.meta.url);
const LABEL = "Sandbox ledger: the real gate, request id, order body and vault authorization sent to the PayPal sandbox; duplicates counted from PayPal's own order and authorization records";

/** Order statuses the web app's duplicate check counts (PLACED in gate-ports.ts, the ones that occur here). */
const PLACED_HERE = new Set(['confirmed', 'authorized']);

interface LocalOrder {
  id: string;
  status: 'confirmed' | 'authorized' | 'failed';
  readbackId: string;
  cartHash: string;
  productId: string;
  variantId: string;
  createdAt: number;
  updatedAt: number;
  reservationId: string;
  purchase: Purchase;
}

interface World extends RequestWorld {
  ctx: SandboxContext;
  tag: string;
  binding: boolean;
  policy: Policy;
  userId: string;
  ledger: InMemoryLedger;
  ports: GatePorts;
  rng: () => number;
  sessions: Map<string, ConfirmationState>;
  localOrders: Map<string, LocalOrder>;
  stops: { stateMachine: number; gate: Record<string, number>; localOrder: number; unknownOutcomeBlock: number; reconciledOnce: number };
  payAttempts: number;
  reconcileResults: Array<{ requestId: string; paypalOrderId?: string; error?: string }>;
  seq: number;
}

const DEAD = ['DENIED', 'DECLINED', 'FAILED', 'VOIDED', 'EXPIRED'];

/** payForReadback with the orders table replaced by the world's local orders; the PayPal half is the app's own. */
const pay: PayFn<World> = async (w, p, t, net, persist) => {
  w.payAttempts++;
  const line0 = p.cart.lines[0]!.snapshot;
  if (w.policy === 'current') {
    // payForReadback: an earlier order for the same item whose outcome is unknown must be settled first.
    // The same readback is left to the idempotent request id, as payments.ts does.
    const blocked = [...w.localOrders.values()].some((o) => o.status === 'confirmed' && o.readbackId !== p.row.id && o.productId === line0.productId && o.variantId === line0.variantId);
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
    payee: { merchantId: w.ctx.merchantId },
    amount: p.cart.totals.total,
    paymentSource: 'vault',
    intent: 'AUTHORIZE',
    now: new Date(T0 + t),
  };
  const d = await runGate(intent, w.ports, w.ctx.gateOpts);
  if (!d.allowed) {
    const code = d.firstFailure?.code ?? 'REFUSED';
    w.stops.gate[code] = (w.stops.gate[code] ?? 0) + 1;
    w.trace.push(`${t}ms gate refused ${code}`);
    persist(t + 30);
    return;
  }
  const requestId = w.binding ? d.requestId : randomRequestId(w.rng);
  const existing = w.localOrders.get(requestId);
  if (existing && existing.status === 'authorized') {
    w.stops.localOrder++;
    persist(t + 30);
    return;
  }
  const reservation = d.reservation!;
  const local: LocalOrder = existing ?? {
    id: `ord_${w.tag.replace(/[^A-Za-z0-9_]/g, '_')}_${++w.seq}`.slice(0, 127),
    status: 'confirmed',
    readbackId: p.row.id,
    cartHash: p.cart.hash,
    productId: line0.productId,
    variantId: line0.variantId,
    createdAt: t,
    updatedAt: t,
    reservationId: reservation.id,
    purchase: p,
  };
  if (!existing) w.localOrders.set(requestId, local);
  const done = t + 50 + payDuration(net);
  let next: LocalOrder['status'] = 'confirmed';
  let release = false;
  let said = '';
  w.ctx.edge.scenario = w.tag;
  w.ctx.edge.dropCreates = Math.min(net.lostResponses, net.maxTries);
  try {
    const res = await payConfirmedReadback(w.ctx, { cart: p.cart, readback: p.row, requestId, orderId: local.id });
    const st = res.authorizationStatus?.toUpperCase();
    if (st && DEAD.includes(st)) {
      next = 'failed';
      release = true;
      said = `PayPal ${res.order.id} authorization ${st}`;
    } else if (st === 'PENDING') said = `PayPal ${res.order.id} pending`;
    else {
      next = 'authorized';
      said = `PayPal ${res.order.id} authorized`;
    }
  } catch (e) {
    if (isAmbiguous(e)) {
      if (w.policy === 'before_fix') {
        next = 'failed';
        release = true;
        said = 'every answer lost; hold released; buyer told nothing was charged';
      } else said = 'every answer lost; outcome unknown; hold and order kept; buyer told the purchase is paused';
    } else {
      next = 'failed';
      release = true;
      said = `PayPal refused: ${e instanceof PayPalApiError ? `${e.status} ${e.issue ?? e.name}` : (e as Error).message}`;
    }
  } finally {
    w.ctx.edge.dropCreates = 0;
  }
  w.trace.push(`${t}ms pay ${requestId.slice(0, 6)}: ${said}`);
  w.sim.at(done, () => {
    if (release) w.ledger.release(reservation.id, 'paypal_error', new Date(T0 + done));
    const o = w.localOrders.get(requestId)!;
    w.localOrders.set(requestId, { ...o, status: next, updatedAt: done });
  });
  persist(done);
};

/** reconcileUnknownOrders: re-send the original create (same request id, same body) for orders whose outcome is unknown. */
async function reconcile(w: World, t: number): Promise<void> {
  for (const [requestId, o] of w.localOrders) {
    if (o.status !== 'confirmed' || t - o.updatedAt < RECONCILE_MIN_AGE_MS) continue;
    w.ctx.edge.scenario = w.tag;
    try {
      const res = await payConfirmedReadback(w.ctx, { cart: o.purchase.cart, readback: o.purchase.row, requestId, orderId: o.id });
      w.localOrders.set(requestId, { ...o, status: 'authorized', updatedAt: t });
      w.stops.reconciledOnce++;
      w.toldWentThrough = true;
      w.reconcileResults.push({ requestId, paypalOrderId: res.order.id });
      w.trace.push(`${t}ms buyer came back; reconciliation re-sent ${requestId.slice(0, 6)} -> PayPal ${res.order.id}; buyer told it went through`);
    } catch (e) {
      const issue = e instanceof PayPalApiError ? e.issue : undefined;
      if (issue === 'DUPLICATE_INVOICE_ID') w.toldWentThrough = true;
      w.reconcileResults.push({ requestId, error: e instanceof PayPalApiError ? `${e.status} ${issue ?? e.name}` : (e as Error).message });
    }
  }
}

interface ScenarioRun {
  id: string;
  family: Family;
  config: string;
  paypalOrders: number;
  paypalAuthorizations: number;
  duplicate: boolean;
  createRequests: number;
  createRequestIds: number;
  droppedAnswers: number;
  payAttempts: number;
  stops: World['stops'];
  orders: Array<{ orderId: string; status: string; amountCents: number; quantity: number; payeeIsStore: boolean; invoiceId?: string; authorizations: Array<{ id: string; status: string }>; captures: number; breaches: string[] }>;
  voids: VoidResult[];
  reconcile: World['reconcileResults'];
  trace: string[];
}

async function runScenario(ctx: SandboxContext, s: Scenario, binding: boolean, policy: Policy, seed: number): Promise<ScenarioRun> {
  const config = `${policy}-${binding ? 'bound' : 'random'}`;
  const R = `${ctx.runId}_${config}`;
  const ledger = new InMemoryLedger();
  const userId = `user_dup_${s.id}_${R}`;
  const item = demoItem(s.product);
  const selection: Record<string, string> = { Colour: item.colours[0]! };
  if (item.sizes?.includes('M')) selection.Size = 'M';
  const product = demoProduct(s.product, selection);
  const SELLER = { name: 'Demo Store', merchantId: ctx.merchantId };
  const snap = freezeSnapshot(product, new Date(T0 + SNAPSHOT_AT), `snap_${s.id}_${R}`, SELLER);
  const base = ledgerPorts(ledger, [ctx.merchantId]);
  const tag = `${s.id}:${config}:${ctx.runId}`;
  const w: World = {
    ctx,
    tag,
    sim: new Sim(),
    binding,
    policy,
    userId,
    ledger,
    ports: base,
    rng: mulberry32(seed),
    readbacks: new Map(),
    sessions: new Map(),
    localOrders: new Map(),
    stops: { stateMachine: 0, gate: {}, localOrder: 0, unknownOutcomeBlock: 0, reconciledOnce: 0 },
    toldWentThrough: false,
    payAttempts: 0,
    trace: [],
    reconcileResults: [],
    seq: 0,
  };
  // As gate-ports.ts: orders already placed for this cart hash count; failed ones do not. Under the
  // current policy an order whose outcome is unknown ('confirmed') counts whatever its age.
  w.ports = {
    ...base,
    recentOrdersForCart: (hash, sinceMs) => [
      ...ledger.recentOrdersForCart(hash, sinceMs),
      ...[...w.localOrders.values()]
        .filter((o) => o.cartHash === hash && PLACED_HERE.has(o.status) && (T0 + o.createdAt >= sinceMs || (w.policy === 'current' && o.status === 'confirmed')))
        .map((o) => ({
          id: o.id,
          cartHash: hash,
          createdAt: w.policy === 'current' && o.status === 'confirmed' ? new Date(Math.max(sinceMs, T0 + o.createdAt)).toISOString() : iso(o.createdAt),
          status: o.status === 'authorized' ? ('authorized' as const) : ('confirmed' as const),
        })),
    ],
  };
  const opts = { payAfterCheck: true };
  w.readbacks.set('rb_main', makePurchase(userId, `rb_${s.id}_${R}`, `cart_${s.id}_${R}`, snap, -60_000, opts));
  for (const later of s.laterReadbacks) {
    w.sim.at(later.at, () => {
      if (later.onlyIfNotToldWentThrough && w.toldWentThrough) return;
      const reuse = later.at - SNAPSHOT_AT < SNAPSHOT_REUSE_MS;
      const useSnap = reuse ? snap : freezeSnapshot(product, new Date(T0 + later.at), `snap_${s.id}_${later.id}_${R}`, SELLER);
      w.trace.push(`${later.at}ms new readback ${later.id} (${reuse ? 'snapshot reused' : 'snapshot re-taken'})`);
      w.readbacks.set(later.id, makePurchase(userId, `rb_${s.id}_${later.id}_${R}`, `cart_${s.id}_${later.id}_${R}`, useSnap, later.at, opts));
    });
  }
  for (const t of s.sessionStarts ?? []) {
    w.sim.at(t, async () => {
      if (w.policy === 'current') await reconcile(w, t);
      else w.trace.push(`${t}ms buyer came back; no reconciliation under this policy`);
    });
  }
  for (const r of s.requests) request(w, r, pay);
  await w.sim.drain();

  // ---- From PayPal ----
  const creates = ctx.edge.calls.filter((c) => c.scenario === tag && c.method === 'POST' && c.path === '/v2/checkout/orders');
  const ids = ctx.edge.ordersCreated(tag);
  ctx.edge.scenario = `${tag}:read`;
  const ledgerOrders: LedgerOrder[] = await readLedger(ctx.pp, ids);
  const terms = termsFromReadback(w.readbacks.get('rb_main')!.row, ctx.merchantId);
  const auths = ledgerOrders.flatMap((o) => o.authorizations);
  ctx.edge.scenario = `${tag}:void`;
  const voids = await voidAll(ctx.pp, auths);
  return {
    id: s.id,
    family: s.family,
    config,
    paypalOrders: ledgerOrders.length,
    paypalAuthorizations: auths.length,
    duplicate: ledgerOrders.length > 1 || auths.length > 1,
    createRequests: creates.length,
    createRequestIds: new Set(creates.map((c) => c.paypalRequestId)).size,
    droppedAnswers: creates.filter((c) => c.dropped).length,
    payAttempts: w.payAttempts,
    stops: w.stops,
    orders: ledgerOrders.map((o) => ({
      orderId: o.id,
      status: o.status,
      amountCents: o.amountCents,
      quantity: o.quantity,
      payeeIsStore: o.payeeMerchantId === ctx.merchantId,
      ...(o.invoiceId ? { invoiceId: o.invoiceId } : {}),
      authorizations: o.authorizations.map((a) => ({ id: a.id, status: a.status })),
      captures: o.captures.length,
      breaches: ledgerBreaches(o, terms),
    })),
    voids,
    reconcile: w.reconcileResults,
    trace: w.trace,
  };
}

async function runSet(ctx: SandboxContext, scenarios: Scenario[], binding: boolean, policy: Policy, seedBase: number, seedIndex: (s: Scenario, i: number) => number = (_, i) => i) {
  const out: ScenarioRun[] = [];
  for (const [i, s] of scenarios.entries()) {
    const r = await runScenario(ctx, s, binding, policy, seedBase + seedIndex(s, i));
    if (r.paypalOrders === 0 && r.stops.reconciledOnce === 0) r.trace.push('no PayPal order at all');
    out.push(r);
    const vs = r.voids.map((v) => v.after ?? v.error).join('/');
    console.log(`${r.config} ${r.id}: ${r.paypalOrders} PayPal order(s), ${r.paypalAuthorizations} auth(s) from ${r.createRequests} create(s) with ${r.createRequestIds} request id(s) (${r.droppedAnswers} answers dropped)${r.duplicate ? ' DUPLICATE' : ''}; void ${vs || 'none'}`);
  }
  return out;
}

const dupCount = (rs: ScenarioRun[]) => rs.filter((r) => r.duplicate).length;
const fam = (rs: ScenarioRun[], ...f: Family[]) => rs.filter((r) => f.includes(r.family));

async function main() {
  const ctx = sandboxContext();
  const startedAt = new Date();
  const offline = JSON.parse(readFileSync(path.join(REPO_ROOT, 'evals/results/duplicates.json'), 'utf8')) as {
    ranAt: string;
    details: { totals: { current: { bound: { dupScenarios: number } }; before_fix: { bound: { dupScenarios: number }; unbound: { dupScenarios: number } } } };
  };
  const scenarios = buildScenarios();
  // Seeds as the local run (50_000 + index), so random ids and timings are the same scenarios.
  const main100 = await runSet(ctx, scenarios, true, 'current', 50_000);
  const probe = buildAfterWindowProbe();
  const stay = await runSet(ctx, probe.stay, true, 'current', 60_000);
  const comeBack = await runSet(ctx, probe.comeBack, true, 'current', 60_000);
  const lostFamilies: Family[] = ['retry_same_confirmation', 'retry_fresh_readback'];
  const lost = scenarios.filter((s) => lostFamilies.includes(s.family));
  const lostSeed = (s: Scenario) => scenarios.indexOf(s);
  const beforeBound = await runSet(ctx, lost, true, 'before_fix', 50_000, lostSeed);
  const beforeRandom = await runSet(ctx, lost, false, 'before_fix', 50_000, lostSeed);

  ctx.edge.scenario = 'transaction-search';
  const all = [...main100, ...stay, ...comeBack, ...beforeBound, ...beforeRandom];
  const allOrders = all.flatMap((r) => r.orders);
  const txCheck = await transactionSearchCheck(ctx.pp, {
    start: new Date(startedAt.getTime() - 24 * 60 * 60 * 1000),
    end: new Date(),
    authorizationIds: allOrders.flatMap((o) => o.authorizations.map((a) => a.id)),
    invoiceIds: allOrders.map((o) => o.invoiceId).filter((x): x is string => !!x),
  });

  const N = main100.length;
  const D = dupCount(main100);
  const mainOrders = main100.reduce((a, r) => a + r.paypalOrders, 0);
  const mainCreates = main100.reduce((a, r) => a + r.createRequests, 0);
  const replays = main100.reduce((a, r) => a + Math.max(0, r.createRequests - r.paypalOrders), 0);
  const lostMain = fam(main100, ...lostFamilies);
  const lostCreated = lostMain.filter((r) => r.paypalOrders >= 1).length;
  const lostDropped = lostMain.reduce((a, r) => a + r.droppedAnswers, 0);
  const same = fam(main100, 'retry_same_confirmation');
  const fresh = fam(main100, 'retry_fresh_readback');
  const reconciledSame = comeBack.filter((r) => r.reconcile.some((x) => x.paypalOrderId && r.orders.some((o) => o.orderId === x.paypalOrderId)) && r.paypalOrders === 1).length;
  const breachOrders = all.flatMap((r) => r.orders).filter((o) => o.breaches.length > 0).length;
  const voids = all.flatMap((r) => r.voids);
  const voided = voids.filter((v) => v.after === 'VOIDED' || v.after === 'VOIDED (204)').length;
  const captures = allOrders.reduce((a, o) => a + o.captures, 0);
  const off = offline.details.totals;
  const lostN = lost.length;

  const headlines: Headline[] = [
    {
      id: 'duplicate-scenarios-sandbox',
      label: 'Scenarios that end with more than one PayPal order or authorization (100 duplicate-prone scenarios, sandbox ledger)',
      value: ofN(D, N),
      baseline: `local simulation: ${ofN(off.current.bound.dupScenarios, N)}`,
      interval: wilsonText(D, N),
      n: N,
      script: SCRIPT,
      negative: D > 0,
      note: `${LABEL}. PayPal holds ${mainOrders} orders for ${N} intended purchases. ${mainCreates} create requests reached PayPal; for ${replays} of them PayPal answered a repeated PayPal-Request-Id with the order it already had.`,
    },
    {
      id: 'lost-response-sandbox',
      label: 'Lost PayPal answer (dropped after PayPal answered), then a resend or a new readback: scenarios with a second PayPal order (sandbox ledger)',
      value: ofN(dupCount(lostMain), lostMain.length),
      baseline: `before the fix, same id: ${ofN(dupCount(beforeBound), lostN)}`,
      interval: wilsonText(dupCount(lostMain), lostMain.length),
      n: lostMain.length,
      script: SCRIPT,
      negative: dupCount(lostMain) > 0,
      note: `${lostDropped} answers dropped at the network edge; PayPal had created the first order in ${ofN(lostCreated, lostMain.length)} (read back from PayPal). Resend on the same confirmation: ${ofN(dupCount(same), same.length)}; new readback within minutes: ${ofN(dupCount(fresh), fresh.length)}.`,
    },
    {
      id: 'lost-response-before-fix-sandbox',
      label: 'Same lost-answer scenarios before the fix (hold released, buyer told nothing was charged), sandbox ledger',
      value: ofN(dupCount(beforeBound), lostN),
      baseline: `random request id per attempt: ${ofN(dupCount(beforeRandom), lostN)}`,
      interval: wilsonText(dupCount(beforeBound), lostN),
      n: lostN,
      script: SCRIPT,
      negative: dupCount(beforeBound) > 0,
      note: `Before fix, kept for comparison; second orders here are real PayPal sandbox orders (authorized, then voided). Local simulation across all 100: ${ofN(off.before_fix.bound.dupScenarios, 100)}, random id ${ofN(off.before_fix.unbound.dupScenarios, 100)}.`,
    },
    {
      id: 'after-window-sandbox',
      label: 'Lost PayPal answer, buyer buys the same item again after the 10-minute duplicate window: second PayPal order (sandbox ledger)',
      value: ofN(dupCount(stay), stay.length),
      interval: wilsonText(dupCount(stay), stay.length),
      n: stay.length,
      script: SCRIPT,
      negative: dupCount(stay) > 0,
      note: 'Separate probe, not in the 100. The ten-minute gap is on the virtual clock; PayPal calls are made in order, a few seconds apart.',
    },
    {
      id: 'reconcile-on-return-sandbox',
      label: 'Buyer comes back after a lost PayPal answer, then would buy again: second PayPal order (sandbox ledger)',
      value: ofN(dupCount(comeBack), comeBack.length),
      interval: wilsonText(dupCount(comeBack), comeBack.length),
      n: comeBack.length,
      script: SCRIPT,
      negative: dupCount(comeBack) > 0,
      note: `Reconciliation re-sent the original create with the original PayPal-Request-Id; PayPal returned the order it had created from the dropped request in ${ofN(reconciledSame, comeBack.length)}.`,
    },
    {
      id: 'orders-match-readback-dup-sandbox',
      label: "PayPal orders in this suite whose amount, payee or quantity differ from the confirmed readback (sandbox ledger)",
      value: ofN(breachOrders, allOrders.length),
      interval: wilsonText(breachOrders, allOrders.length),
      n: allOrders.length,
      script: SCRIPT,
      negative: breachOrders > 0,
      note: `Captures found: ${captures}.`,
    },
    {
      id: 'authorizations-voided-dup-sandbox',
      label: 'Sandbox authorizations voided at the end of their scenario',
      value: ofN(voided, voids.length),
      n: voids.length,
      script: SCRIPT,
      negative: voided < voids.length,
      note: 'Every authorization the run created, including those from dropped answers, is voided so the sandbox buyer is never charged.',
    },
  ];

  const limitations = [
    `${LABEL}. One run against the sandbox; PayPal's sandbox may behave differently from production, and its request-id retention was only exercised over minutes, not hours.`,
    'Only the PayPal side is real. The buyer side runs on the local run\'s virtual clock (scripted timings, last-writer-wins session state, two independent tabs), and the orders table and Postgres budget holds of payForReadback are replaced by local orders and the gate\'s InMemoryLedger, read the way gate-ports.ts reads the database. The pay step\'s PayPal half is the app\'s own code (orderInputFromCart, createVaultOrder, completeOrder).',
    'A lost answer is simulated at the network edge only: PayPal received every create and answered; the answer was dropped before the HTTP client saw it, and the client retried with the same PayPal-Request-Id. A request that never reached PayPal was not tested.',
    'The OUTCOME_UNKNOWN block follows payments.ts exactly (an unsettled order for the same item on another readback); the local simulation also blocks a resend on the same readback. Either way, a resend on the same readback carries the same PayPal-Request-Id.',
    'Intent AUTHORIZE throughout (the readback says PayPal holds the money until the item checks out); nothing is captured and every authorization is voided. The local run uses CAPTURE.',
    'Only the current policy with the bound request id runs on all 100 scenarios and the after-window probe; the before-fix baseline runs on the 20 lost-answer scenarios only. The hold_kept policy is local only.',
    'Key 2 is a stub that agrees exactly when key 1 does; the real classifier needs ANTHROPIC_API_KEY.',
    `Transaction Search cross-check (secondary): ${txCheck.enabled ? `${txCheck.authorizationsFound} of ${txCheck.authorizationsExpected} authorization ids listed when read at the end of the run; ${txCheck.listed} transactions in the window` : `not available (${txCheck.error})`}. It can lag by hours, so it is not used for any count.`,
  ];

  writeResult('duplicates-sandbox', {
    title: 'Duplicate orders, sandbox ledger',
    headlines,
    limitations,
    details: {
      label: LABEL,
      runId: ctx.runId,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      duplicateDefinition: 'A scenario (one intended purchase) for which PayPal holds more than one order, or more than one authorization, among the orders its create requests produced. Order ids come from PayPal\'s answers at the network edge (dropped answers included); each order and authorization is then read with GET.',
      requestId: "paypalRequestId('order', cart.hash, readback.id), computed by runGate; sent by createVaultOrder",
      totals: {
        main: { n: N, duplicates: D, interval: wilsonText(D, N), paypalOrders: mainOrders, createRequests: mainCreates, paypalReplays: replays },
        lostAnswer: { n: lostMain.length, duplicates: dupCount(lostMain), droppedAnswers: lostDropped, firstOrderCreated: lostCreated },
        afterWindow: { sameSession: { n: stay.length, duplicates: dupCount(stay) }, buyerComesBack: { n: comeBack.length, duplicates: dupCount(comeBack), reconciledToOriginalOrder: reconciledSame } },
        beforeFix: { n: lostN, bound: dupCount(beforeBound), random: dupCount(beforeRandom) },
        orders: allOrders.length,
        breachOrders,
        captures,
        authorizations: voids.length,
        voided,
      },
      byFamily: Object.fromEntries(
        [...new Set(main100.map((r) => r.family))].map((f) => [f, { n: fam(main100, f).length, duplicates: dupCount(fam(main100, f)), paypalOrders: fam(main100, f).reduce((a, r) => a + r.paypalOrders, 0) }]),
      ),
      paypalCalls: ctx.edge.summary(),
      paypalCallCount: ctx.edge.calls.length,
      pacing: 'At most 2 requests a second at the network edge; on 429 the edge waits (Retry-After or exponential) and halves its rate.',
      transactionSearch: txCheck,
      scenarios: main100,
      afterWindowProbe: { sameSession: stay, buyerComesBack: comeBack },
      beforeFixBaseline: { bound: beforeBound, random: beforeRandom },
    },
  });

  console.log(`duplicates-sandbox: ${ofN(D, N)} duplicate scenarios (${mainOrders} PayPal orders, ${mainCreates} creates, ${replays} replays); lost-answer ${ofN(dupCount(lostMain), lostMain.length)}; before-fix bound ${dupCount(beforeBound)}, random ${dupCount(beforeRandom)} of ${lostN}; after-window ${dupCount(stay)}, come back ${dupCount(comeBack)} (reconciled to original ${reconciledSame}); breaches ${breachOrders}; voided ${voided}/${voids.length}; PayPal calls ${ctx.edge.calls.length}`);
  console.log(`transaction search: ${JSON.stringify({ enabled: txCheck.enabled, listed: txCheck.listed, found: txCheck.authorizationsFound, error: txCheck.error })}`);
}

await main();
