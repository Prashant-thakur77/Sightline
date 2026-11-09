import 'server-only';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { tables } from '@sightline/db';
import { paymentStatus, type Confidence, type ProductSnapshot, type Verdict, type VerdictReason } from '@sightline/core';
import { centsText, durationText } from '@/components/studio/formats';
import type {
  BarrierData,
  BarrierPlatformRow,
  BarrierRuleRow,
  BarrierStoreRow,
  MoneyState,
  StudioAgentStatus,
  StudioCaseRow,
  StudioCheckReasonRow,
  StudioCheckRow,
  StudioOrderRow,
  StudioWebhookRow,
  VerdictWord,
  VerifiedDeliveryData,
} from '@/components/studio/types';
import { db, ENV } from './runtime';

/*
 * Data for the AG Studio dashboards. Every number on those pages, and every sentence in the summary
 * read out above them, comes from here: the order, check and case records in Postgres, and the
 * Barrier Index results file the crawl script writes. Nothing is typed in by hand.
 */

// ---------------------------------------------------------------------------------------------
// Configuration the pages need. Keys stay on the server; the client is told only what is switched on.

/** The AG Studio licence key, when one is set. Without it Studio runs as a trial with a watermark. */
export function studioLicenceKey(): string | undefined {
  return ENV.AG_STUDIO || undefined;
}

export function studioAgentStatus(): StudioAgentStatus {
  const enabled = Boolean(ENV.ANTHROPIC_API_KEY);
  return { enabled, model: enabled ? studioAgentModel() : null };
}

export function studioAgentModel(): string {
  return ENV.AGENT_MODEL || 'claude-opus-5-5';
}

// ---------------------------------------------------------------------------------------------
// Words

const ASPECT: Record<string, string> = {
  colour: 'Colour',
  size: 'Size',
  identity: 'Item',
  damage: 'Damage',
  quality: 'Photo quality',
};
/** What kind of mismatch a disagreeing check module means. */
const MISMATCH_TYPE: Record<string, string> = {
  colour: 'Wrong colour',
  size: 'Wrong size',
  identity: 'Wrong item',
  damage: 'Damaged',
  quality: 'Photo unclear',
};
/**
 * What a check that was not sure was unsure of, in plain words: a difference it was not sure
 * enough of to call a mismatch, or an aspect it could not check from the photos.
 */
const UNSURE_TYPE: Record<string, { maybe: string; unknown: string }> = {
  colour: { maybe: 'Colour may be wrong', unknown: 'Could not check colour' },
  size: { maybe: 'Size may be wrong', unknown: 'Could not check size' },
  identity: { maybe: 'May be the wrong item', unknown: 'Could not check the item' },
  damage: { maybe: 'May be damaged', unknown: 'Could not check for damage' },
  quality: { maybe: 'Photos too unclear', unknown: 'Photos too unclear' },
};
const FINDING: Record<VerdictReason['finding'], string> = {
  agree: 'Agrees with the order',
  disagree: 'Does not match',
  unknown: 'Could not tell',
};
const CONFIDENCE: Record<Confidence, string> = { sure: 'sure', fairly_sure: 'fairly sure', not_sure: 'not sure' };
const CONFIDENCE_RANK: Record<Confidence, number> = { not_sure: 0, fairly_sure: 1, sure: 2 };
const VERDICT: Record<Verdict['kind'], { word: VerdictWord; glyph: string }> = {
  match: { word: 'Match', glyph: '✓' },
  mismatch: { word: 'Mismatch', glyph: '✕' },
  unsure: { word: 'Not sure', glyph: '?' },
};
const CASE_REASON: Record<string, string> = {
  wrong_colour: 'Wrong colour',
  wrong_size: 'Wrong size',
  wrong_item: 'Wrong item',
  damaged: 'Damaged',
  not_received: 'Not received',
};
const SHIPPED: Record<string, string> = {
  correct: 'Right item',
  wrong_colour: 'Wrong colour',
  wrong_size: 'Wrong size',
  damaged: 'Damaged item',
  nothing: 'Nothing shipped',
};

type OrderRecord = typeof tables.orders.$inferSelect;

/*
 * Where the money is comes from paymentStatus in @sightline/core, the same words the buyer's pages
 * and the merchant console use. "On hold" means PayPal holds an authorization; an order with no
 * PayPal order is "Not paid", whatever its delivery status says.
 */
const MONEY = { held: 'On hold', paid: 'Paid', released: 'Hold released', refunded: 'Refunded', notPaid: 'Not paid' } as const;

function moneyState(o: OrderRecord): MoneyState {
  return paymentStatus(o).word;
}

/** Short, speakable reference for an id: the last six characters, upper case. */
const shortRef = (id: string) => id.slice(-6).toUpperCase();

function stageText(stage: string, outcome: unknown): string {
  switch (stage) {
    case 'seller_contacted':
      return 'Needs your reply';
    case 'offer_received':
      return 'Offer made, buyer deciding';
    case 'accepted':
      return 'Buyer accepted';
    case 'declined':
      return 'Buyer declined the offer';
    case 'escalated':
      return 'Escalated to PayPal';
    case 'under_review':
      return 'PayPal is reviewing';
    case 'resolved': {
      const kind = (outcome as { kind?: string } | null)?.kind;
      return `Resolved${kind === 'voided' ? ': hold released' : kind === 'refunded' ? ': refunded' : ''}`;
    }
    default:
      return stage.replace(/_/g, ' ');
  }
}

/** The reason that decided a verdict: the first one that disagrees, else the first it could not tell. */
function decidingReason(v: Verdict): VerdictReason | null {
  return (
    v.reasons.find((r) => r.finding === 'disagree') ??
    v.reasons.find((r) => r.finding === 'unknown') ??
    [...v.reasons].sort((a, b) => CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence])[0] ??
    null
  );
}

function latencyOf(moduleOutputs: unknown): number | null {
  const t = (moduleOutputs as { timings_ms?: Record<string, number> } | null)?.timings_ms;
  if (!t) return null;
  if (typeof t.total === 'number') return Math.round(t.total);
  const parts = Object.values(t).filter((n): n is number => typeof n === 'number');
  return parts.length ? Math.round(parts.reduce((a, b) => a + b, 0)) : null;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const iso = (t: string) => new Date(t).toISOString();

// ---------------------------------------------------------------------------------------------
// Demo Store: verified delivery

/**
 * Each visitor plays both sides of the demo, so the dashboard shows only the orders of the demo
 * shopper in this browser session, like the rest of the merchant console.
 */
export async function loadVerifiedDelivery(scopeUserId: string): Promise<VerifiedDeliveryData> {
  const orders = await db()
    .select()
    .from(tables.orders)
    .where(eq(tables.orders.userId, scopeUserId))
    .orderBy(desc(tables.orders.createdAt))
    .limit(1000);
  const ids = orders.map((o) => o.id);
  const none = ids.length === 0;
  const [users, snaps, ships, vers, kases, voidAudits, hooks] = await Promise.all([
    none
      ? []
      : db()
          .select({ id: tables.users.id, name: tables.users.displayName })
          .from(tables.users)
          .where(inArray(tables.users.id, [...new Set(orders.map((o) => o.userId))])),
    none
      ? []
      : db()
          .select({ id: tables.productSnapshots.id, body: tables.productSnapshots.body })
          .from(tables.productSnapshots)
          .where(inArray(tables.productSnapshots.id, [...new Set(orders.map((o) => o.snapshotId))])),
    none ? [] : db().select().from(tables.shipments).where(inArray(tables.shipments.orderId, ids)),
    none
      ? []
      : db()
          .select()
          .from(tables.verifications)
          .where(inArray(tables.verifications.orderId, ids))
          .orderBy(desc(tables.verifications.createdAt)),
    none
      ? []
      : db()
          .select()
          .from(tables.cases)
          .where(and(eq(tables.cases.userId, scopeUserId), sql`${tables.cases.stage} not in ('draft', 'evidence_built')`))
          .orderBy(desc(tables.cases.createdAt)),
    none
      ? []
      : db()
          .select({ subjectId: tables.auditLog.subjectId })
          .from(tables.auditLog)
          .where(and(eq(tables.auditLog.action, 'payment.voided_after_check'), inArray(tables.auditLog.subjectId, ids))),
    none
      ? []
      : db()
          .select({
            id: tables.webhookEvents.id,
            type: tables.webhookEvents.type,
            raw: tables.webhookEvents.raw,
            receivedAt: tables.webhookEvents.receivedAt,
            signatureOk: tables.webhookEvents.signatureOk,
            processedAt: tables.webhookEvents.processedAt,
          })
          .from(tables.webhookEvents)
          .orderBy(desc(tables.webhookEvents.receivedAt))
          .limit(2000),
  ]);

  const nameOf = new Map(users.map((u) => [u.id, u.name]));
  const snapOf = new Map(snaps.map((s) => [s.id, s.body as ProductSnapshot]));
  const shipOf = new Map(ships.map((s) => [s.orderId, s]));
  const orderOf = new Map(orders.map((o) => [o.id, o]));
  const voidedAfter = new Set(voidAudits.map((a) => a.subjectId).filter((x): x is string => Boolean(x)));

  // One check per order: the latest verdict is the one the order acted on.
  const latest = new Map<string, (typeof vers)[number]>();
  for (const v of vers) if (v.verdict && !latest.has(v.orderId)) latest.set(v.orderId, v);

  const checks: StudioCheckRow[] = [];
  const checkReasons: StudioCheckReasonRow[] = [];
  for (const v of latest.values()) {
    const o = orderOf.get(v.orderId);
    if (!o) continue;
    const verdict = v.verdict as Verdict;
    const deciding = decidingReason(verdict);
    const disagree = new Set(verdict.reasons.filter((r) => r.finding === 'disagree').map((r) => r.module));
    const mismatch = verdict.kind === 'mismatch';
    const snap = snapOf.get(o.snapshotId);
    checks.push({
      id: v.id,
      orderId: o.id,
      orderRef: shortRef(o.id),
      checkedAt: iso(v.createdAt),
      buyer: nameOf.get(o.userId) ?? 'Buyer',
      item: snap?.title ?? o.title,
      verdict: VERDICT[verdict.kind].word,
      verdictLabel: `${VERDICT[verdict.kind].glyph} ${VERDICT[verdict.kind].word}`,
      mismatchType:
        verdict.kind === 'match' || !deciding
          ? 'No mismatch'
          : verdict.kind === 'unsure'
            ? (UNSURE_TYPE[deciding.module]?.[deciding.finding === 'disagree' ? 'maybe' : 'unknown'] ??
              `Not sure: ${ASPECT[deciding.module]?.toLowerCase() ?? deciding.module}`)
            : (MISMATCH_TYPE[deciding.module] ?? deciding.module),
      confidence: deciding ? CONFIDENCE[deciding.confidence] : 'not sure',
      headline: verdict.headline,
      latencyMs: latencyOf(v.moduleOutputs),
      isMatch: verdict.kind === 'match' ? 1 : 0,
      isMismatch: mismatch ? 1 : 0,
      isUnsure: verdict.kind === 'unsure' ? 1 : 0,
      wrongColour: mismatch && disagree.has('colour') ? 1 : 0,
      wrongSize: mismatch && disagree.has('size') ? 1 : 0,
      wrongItem: mismatch && disagree.has('identity') ? 1 : 0,
      damaged: mismatch && disagree.has('damage') ? 1 : 0,
    });
    verdict.reasons.forEach((r, i) =>
      checkReasons.push({
        id: `${v.id}:${i}`,
        checkId: v.id,
        aspect: ASPECT[r.module] ?? r.module,
        finding: FINDING[r.finding],
        confidence: CONFIDENCE[r.confidence],
        expected: r.expected ?? '',
        observed: r.observed ?? '',
        sentence: r.sentence,
      }),
    );
  }
  checks.sort((a, b) => b.checkedAt.localeCompare(a.checkedAt));
  const checkedOrders = new Set(checks.map((c) => c.orderId));
  const mismatchOrders = new Set(checks.filter((c) => c.isMismatch).map((c) => c.orderId));

  const orderRows: StudioOrderRow[] = orders.map((o) => {
    const snap = snapOf.get(o.snapshotId);
    const s = shipOf.get(o.id);
    const state = moneyState(o);
    const delivered = s?.deliveredAt ? 1 : 0;
    const checked = checkedOrders.has(o.id) ? 1 : 0;
    const cents = (want: MoneyState) => (state === want ? o.amountCents : 0);
    const noPayPal = state === MONEY.notPaid && !o.paypalOrderId;
    return {
      id: o.id,
      ref: shortRef(o.id),
      createdAt: iso(o.createdAt),
      buyer: nameOf.get(o.userId) ?? 'Buyer',
      item: snap?.title ?? o.title,
      colour: snap?.attributes.colour ?? '',
      size: snap?.attributes.size ?? '',
      status: o.status.replace(/_/g, ' '),
      moneyState: state,
      payAfterCheck: o.intent === 'AUTHORIZE' ? 1 : 0,
      amountCents: o.amountCents,
      heldCents: cents(MONEY.held),
      capturedCents: cents(MONEY.paid),
      voidedCents: cents(MONEY.released),
      refundedCents: cents(MONEY.refunded),
      // paymentStatus says "No PayPal order exists. Nothing was charged." for exactly these.
      notPaidCents: noPayPal ? o.amountCents : 0,
      noPayPalOrder: noPayPal ? 1 : 0,
      shipped: !s || s.status === 'awaiting_shipment' ? 'Not shipped yet' : (SHIPPED[s.shippedVariant] ?? s.shippedVariant),
      delivered,
      checked,
      verifiedDelivery: delivered && checked ? 1 : 0,
      // PayPal held this order's money while the buyer checked the parcel.
      heldForCheck: checked && o.intent === 'AUTHORIZE' && o.paypalOrderId && o.authorizationId ? 1 : 0,
      // A hold released after the buyer's check found the wrong item: a dispute that never had to happen.
      voidedAfterMismatch: voidedAfter.has(o.id) && mismatchOrders.has(o.id) ? 1 : 0,
    };
  });

  const caseRows: StudioCaseRow[] = kases
    .filter((c) => orderOf.has(c.orderId))
    .map((c) => {
      const resolved = c.stage === 'resolved';
      const span = new Date(c.updatedAt).getTime() - new Date(c.createdAt).getTime();
      const outcome = (c.outcome as { kind?: string } | null)?.kind;
      return {
        id: c.id,
        ref: shortRef(c.id),
        orderId: c.orderId,
        stage: stageText(c.stage, c.outcome),
        reason: CASE_REASON[c.reason] ?? c.reason.replace(/_/g, ' '),
        outcome: !resolved
          ? 'Still open'
          : outcome === 'voided'
            ? 'Hold released'
            : outcome === 'refunded'
              ? 'Refunded'
              : 'Resolved',
        openedAt: iso(c.createdAt),
        resolvedAt: resolved ? iso(c.updatedAt) : null,
        hoursToResolution: resolved && span >= 0 ? span / 3_600_000 : null,
        open: resolved ? 0 : 1,
      };
    });

  // PayPal events carry PayPal's ids, not ours: keep only the ones about this shopper's payments.
  const paypalIds = orders
    .flatMap((o) => [o.paypalOrderId, o.captureId, o.authorizationId])
    .filter((x): x is string => Boolean(x));
  const webhookEvents: StudioWebhookRow[] = hooks
    .filter((h) => paypalIds.some((pid) => h.raw.includes(pid)))
    .map((h) => ({
    id: h.id,
    type: h.type,
    receivedAt: iso(h.receivedAt),
    signatureOk: h.signatureOk ? 1 : 0,
    processed: h.processedAt ? 1 : 0,
  }));

  const sum = (xs: StudioOrderRow[], k: keyof StudioOrderRow) => xs.reduce((a, r) => a + (r[k] as number), 0);
  const reasons = [
    { reason: 'Wrong colour', count: checks.reduce((a, c) => a + c.wrongColour, 0) },
    { reason: 'Wrong size', count: checks.reduce((a, c) => a + c.wrongSize, 0) },
    { reason: 'Wrong item', count: checks.reduce((a, c) => a + c.wrongItem, 0) },
    { reason: 'Damaged', count: checks.reduce((a, c) => a + c.damaged, 0) },
  ];
  const resolvedHours = caseRows.map((c) => c.hoursToResolution).filter((h): h is number => h !== null);
  const medianHours = median(resolvedHours);

  return {
    asOf: new Date().toISOString(),
    orders: orderRows,
    checks,
    checkReasons,
    cases: caseRows,
    webhookEvents,
    summary: {
      orders: orderRows.length,
      delivered: sum(orderRows, 'delivered'),
      verifiedDeliveries: sum(orderRows, 'verifiedDelivery'),
      checks: checks.length,
      matches: checks.filter((c) => c.isMatch).length,
      mismatches: checks.filter((c) => c.isMismatch).length,
      unsure: checks.filter((c) => c.verdict === 'Not sure').length,
      byReason: reasons,
      heldCents: sum(orderRows, 'heldCents'),
      capturedCents: sum(orderRows, 'capturedCents'),
      voidedCents: sum(orderRows, 'voidedCents'),
      refundedCents: sum(orderRows, 'refundedCents'),
      notPaidCents: sum(orderRows, 'notPaidCents'),
      noPayPalOrders: sum(orderRows, 'noPayPalOrder'),
      heldForCheck: sum(orderRows, 'heldForCheck'),
      casesAvoided: sum(orderRows, 'voidedAfterMismatch'),
      openCases: caseRows.filter((c) => c.open).length,
      resolvedCases: resolvedHours.length,
      medianResolutionMs: medianHours === null ? null : Math.round(medianHours * 3_600_000),
      webhookEvents: webhookEvents.length,
    },
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const pct = (k: number, n: number) => (n ? `${Math.round((k / n) * 100)}%` : 'no data yet');
const usd = centsText;

export interface SpokenFigure {
  id: string;
  label: string;
  value: string;
  detail: string;
}

/** The same numbers as the dashboard's KPI tiles, as sentences a screen reader can read in order. */
export function verifiedDeliveryFigures(d: VerifiedDeliveryData): SpokenFigure[] {
  const s = d.summary;
  const reasons = s.byReason.filter((r) => r.count > 0);
  return [
    {
      id: 'orders',
      label: 'Orders',
      value: String(s.orders),
      detail: `${plural(s.delivered, 'order')} delivered so far.`,
    },
    {
      // Says what it counts: a check that found the wrong item is still a check, so the figure is
      // "2 of 2 checked", never a rate that reads as "all verified".
      id: 'verified',
      label: 'Delivered and checked',
      value: s.delivered === 0 ? 'None delivered yet' : `${s.verifiedDeliveries} of ${s.delivered}`,
      detail:
        s.delivered === 0
          ? 'No parcel has been delivered yet.'
          : `${s.verifiedDeliveries} of ${plural(s.delivered, 'delivered order')} checked by the buyer with the camera. ` +
            (s.checks === 0
              ? 'No check has answered yet.'
              : `Of ${plural(s.checks, 'check')}, ${s.matches} matched the order, ${s.mismatches} did not, and ${s.unsure} could not tell.`),
    },
    {
      id: 'wrong',
      label: 'Wrong-item rate',
      value: pct(s.mismatches, s.checks),
      detail:
        s.checks === 0
          ? 'No checks yet.'
          : `${s.mismatches} of ${plural(s.checks, 'check')} found the wrong item${
              reasons.length ? `: ${reasons.map((r) => `${r.reason.toLowerCase()} ${r.count}`).join(', ')}` : ''
            }. ${plural(s.unsure, 'check')} could not tell.`,
    },
    {
      id: 'money',
      label: 'Where the money is',
      value: `${usd(s.heldCents)} on hold with PayPal`,
      detail:
        `${usd(s.capturedCents)} paid to Demo Store, ${usd(s.voidedCents)} released from a hold, ${usd(s.refundedCents)} refunded.` +
        (s.noPayPalOrders
          ? ` ${plural(s.noPayPalOrders, 'order')} (${usd(s.notPaidCents)}) ${s.noPayPalOrders === 1 ? 'has' : 'have'} no PayPal order, so nothing was charged for ${s.noPayPalOrders === 1 ? 'it' : 'them'}.`
          : ''),
    },
    {
      id: 'avoided',
      label: 'Cases avoided by pay after check',
      value: String(s.casesAvoided),
      detail: `${plural(s.casesAvoided, 'hold')} released after the check found a mismatch, so no dispute was needed.`,
    },
    {
      id: 'median',
      label: 'Median time to resolution',
      value: s.medianResolutionMs === null ? 'None yet' : `${(s.medianResolutionMs / 3_600_000).toFixed(1)} hours`,
      detail:
        s.medianResolutionMs === null
          ? `No case resolved yet. ${plural(s.openCases, 'case')} still open.`
          : `That is ${durationText(s.medianResolutionMs)}, across ${plural(s.resolvedCases, 'resolved case')}. ${plural(s.openCases, 'case')} still open.`,
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// Checkout Barrier Index

interface BarrierFile {
  suite?: string;
  ranAt?: string;
  gitSha?: string;
  details?: {
    byPlatform?: Record<
      string,
      {
        stores?: number;
        crawled?: number;
        blocked?: number;
        medianViolationsProduct?: number | null;
        medianViolationsHome?: number | null;
        keyboardReachAddToCartRate?: number | null;
        keyboardReachDenominator?: number;
      }
    >;
    topRules?: { id: string; help?: string; storesAffected: number; totalNodes?: number }[];
    stores?: Record<string, unknown>[];
  };
}

/**
 * Platform names as the crawl's own labels write them (PLATFORM_LABELS in evals/barrier/lib.mjs).
 * "custom" means no known platform was detected, so it is "Custom or other", not "custom-built".
 */
const PLATFORM: Record<string, string> = {
  shopify: 'Shopify',
  woocommerce: 'WooCommerce',
  magento: 'Magento / Adobe Commerce',
  bigcommerce: 'BigCommerce',
  sfcc: 'Salesforce Commerce Cloud',
  custom: 'Custom or other',
};

/** A platform key from the results file as a name a person reads: "sfcc" -> "Salesforce Commerce Cloud". */
export function platformName(key: string): string {
  return PLATFORM[key] ?? key;
}
const KEYBOARD: Record<string, string> = {
  reached: 'Reached add to cart',
  'not-reached': 'Could not reach add to cart',
  'overlay-blocked': 'A dialog held focus',
  'atc-needs-selection': 'Needs a size first',
  'no-atc': 'No add-to-cart button found',
  error: 'Walk failed',
};
const STATUS: Record<string, string> = {
  ok: 'Audited',
  blocked: 'Refused the crawler',
  robots: 'Disallowed by robots.txt',
  'no-product': 'No product page found',
  error: 'Crawler error',
};
const TRAP: Record<string, string> = {
  none: 'No trap',
  trapped: 'Trapped',
  'escaped-with-escape': 'Escape freed it',
};

function barrierFile(): string {
  // apps/web runs with cwd = apps/web in dev and in the standalone build.
  return path.resolve(process.cwd(), '../../evals/results/barrier.json');
}

const numOrNull = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/** The Barrier Index rows, or null when the crawl has not been run on this build. */
export async function loadBarrierIndex(): Promise<BarrierData | null> {
  let file: BarrierFile;
  try {
    file = JSON.parse(await readFile(barrierFile(), 'utf8')) as BarrierFile;
  } catch {
    return null;
  }
  if (file.suite !== 'barrier' || !file.details) return null;
  const d = file.details;

  const stores: BarrierStoreRow[] = (d.stores ?? []).map((r) => {
    const outcome = typeof r.keyboardOutcome === 'string' ? r.keyboardOutcome : null;
    const tested = outcome === 'reached' || outcome === 'not-reached';
    const unnamedProduct = numOrNull(r.unnamedButtonsProduct);
    const unnamedHome = numOrNull(r.unnamedButtonsHome);
    const platform = String(r.platform ?? 'custom');
    return {
      id: String(r.domainHash ?? ''),
      platform: PLATFORM[platform] ?? platform,
      status: STATUS[String(r.status)] ?? String(r.status ?? 'unknown'),
      audited: numOrNull(r.productViolations) === null ? 0 : 1,
      productViolations: numOrNull(r.productViolations),
      homeViolations: numOrNull(r.homeViolations),
      productCriticalOrSerious: numOrNull(r.productCriticalOrSerious),
      keyboardOutcome: outcome ? (KEYBOARD[outcome] ?? outcome) : 'Not tested',
      keyboardTested: tested ? 1 : 0,
      keyboardReached: outcome === 'reached' ? 1 : 0,
      tabsToAddToCart: numOrNull(r.tabsToAddToCart),
      focusTrap: typeof r.focusTrap === 'string' ? (TRAP[r.focusTrap] ?? r.focusTrap) : 'Not tested',
      unnamedButtonsChecked: unnamedProduct === null ? 0 : 1,
      unnamedButtons: unnamedProduct !== null && unnamedProduct + (unnamedHome ?? 0) > 0 ? 1 : 0,
    };
  });
  const rules: BarrierRuleRow[] = (d.topRules ?? []).map((r) => ({
    id: r.id,
    help: r.help ?? '',
    storesAffected: r.storesAffected,
    totalNodes: r.totalNodes ?? 0,
  }));
  const platforms: BarrierPlatformRow[] = Object.entries(d.byPlatform ?? {}).map(([key, p]) => ({
    id: key,
    platform: PLATFORM[key] ?? key,
    stores: p.stores ?? 0,
    crawled: p.crawled ?? 0,
    blocked: p.blocked ?? 0,
    medianViolationsProduct: numOrNull(p.medianViolationsProduct),
    medianViolationsHome: numOrNull(p.medianViolationsHome),
    keyboardReachRate: numOrNull(p.keyboardReachAddToCartRate),
    keyboardReachDenominator: p.keyboardReachDenominator ?? 0,
  }));

  const crawled = stores.filter((s) => s.productViolations !== null);
  const worst = platforms
    .filter((p) => p.medianViolationsProduct !== null && p.crawled > 0)
    .sort((a, b) => b.medianViolationsProduct! - a.medianViolationsProduct!)[0];
  return {
    ranAt: file.ranAt ?? '',
    gitSha: file.gitSha ?? 'unknown',
    stores,
    rules,
    platforms,
    summary: {
      stores: stores.length,
      crawled: crawled.length,
      blocked: stores.filter((s) => s.status === STATUS.blocked).length,
      medianViolationsProduct: median(crawled.map((s) => s.productViolations!)),
      keyboardTested: stores.reduce((a, s) => a + s.keyboardTested, 0),
      keyboardReached: stores.reduce((a, s) => a + s.keyboardReached, 0),
      unnamedChecked: stores.reduce((a, s) => a + s.unnamedButtonsChecked, 0),
      unnamedStores: stores.reduce((a, s) => a + s.unnamedButtons, 0),
      topRule: rules[0] ?? null,
      worstPlatform: worst ? { platform: worst.platform, medianViolationsProduct: worst.medianViolationsProduct! } : null,
    },
  };
}

/** Ends a rule's help text with a full stop, once. */
export const sentence = (t: string) => (t.trim() ? t.trim().replace(/[.!?]?$/, (m) => m || '.') : '');

const fig = (x: number | null) => (x === null ? 'no data' : Number.isInteger(x) ? String(x) : x.toFixed(1));

export function barrierFigures(d: BarrierData): SpokenFigure[] {
  const s = d.summary;
  return [
    {
      id: 'stores',
      label: 'Stores crawled',
      value: String(s.crawled),
      detail: `${s.crawled} of ${plural(s.stores, 'sampled store')} had a product page audited. ${plural(s.blocked, 'store')} refused the crawler and ${s.blocked === 1 ? 'is' : 'are'} left out.`,
    },
    {
      id: 'median',
      label: 'Median failures per product page',
      value: fig(s.medianViolationsProduct),
      detail: s.worstPlatform
        ? `Distinct automated accessibility rules failed. Highest platform median: ${s.worstPlatform.platform}, ${fig(s.worstPlatform.medianViolationsProduct)}.`
        : 'Distinct automated accessibility rules failed.',
    },
    {
      id: 'keyboard',
      label: 'Add to cart reachable by keyboard',
      value: pct(s.keyboardReached, s.keyboardTested),
      detail: `${s.keyboardReached} of ${plural(s.keyboardTested, 'store')} where the walk could be judged, using Tab only.`,
    },
    {
      id: 'unnamed',
      label: 'Stores with an unnamed button',
      value: pct(s.unnamedStores, s.unnamedChecked),
      detail: `${s.unnamedStores} of ${plural(s.unnamedChecked, 'store')}. A screen reader says only "button" for these.`,
    },
    {
      id: 'top-rule',
      label: 'Most common failing rule',
      value: s.topRule?.id ?? 'none',
      detail: s.topRule ? `${sentence(s.topRule.help)} Found on ${plural(s.topRule.storesAffected, 'store')}.` : 'No rule data.',
    },
  ];
}
