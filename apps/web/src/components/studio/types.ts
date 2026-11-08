/*
 * Plain rows the server hands to the AG Studio dashboards. Everything here is serialisable, so a
 * server component can pass it straight to a client component. Money is integer cents; flags that
 * Studio sums are 1 or 0.
 */

export type MoneyState = 'Held' | 'Captured' | 'Voided' | 'Refunded' | 'Awaiting approval' | 'Not placed' | 'Pending';

export interface StudioOrderRow {
  id: string;
  ref: string;
  createdAt: string;
  buyer: string;
  item: string;
  colour: string;
  size: string;
  status: string;
  moneyState: MoneyState;
  payAfterCheck: number;
  amountCents: number;
  heldCents: number;
  capturedCents: number;
  voidedCents: number;
  refundedCents: number;
  shipped: string;
  delivered: number;
  checked: number;
  verifiedDelivery: number;
  voidedAfterMismatch: number;
}

export type VerdictWord = 'Match' | 'Mismatch' | 'Not sure';

export interface StudioCheckRow {
  id: string;
  orderId: string;
  orderRef: string;
  checkedAt: string;
  buyer: string;
  item: string;
  verdict: VerdictWord;
  /** The verdict with its shape, so the grid never relies on colour: "✕ Mismatch". */
  verdictLabel: string;
  mismatchType: string;
  confidence: string;
  headline: string;
  latencyMs: number | null;
  isMismatch: number;
  wrongColour: number;
  wrongSize: number;
  wrongItem: number;
  damaged: number;
}

export interface StudioCheckReasonRow {
  id: string;
  checkId: string;
  aspect: string;
  finding: string;
  confidence: string;
  expected: string;
  observed: string;
  sentence: string;
}

export interface StudioCaseRow {
  id: string;
  ref: string;
  orderId: string;
  stage: string;
  reason: string;
  outcome: string;
  openedAt: string;
  resolvedAt: string | null;
  hoursToResolution: number | null;
  open: number;
}

export interface StudioWebhookRow {
  id: string;
  type: string;
  receivedAt: string;
  signatureOk: number;
  processed: number;
}

/** The headline numbers, computed once on the server and read out above the dashboard. */
export interface VerifiedDeliverySummary {
  orders: number;
  delivered: number;
  verifiedDeliveries: number;
  checks: number;
  mismatches: number;
  unsure: number;
  byReason: { reason: string; count: number }[];
  heldCents: number;
  capturedCents: number;
  voidedCents: number;
  refundedCents: number;
  casesAvoided: number;
  openCases: number;
  resolvedCases: number;
  medianResolutionMs: number | null;
  webhookEvents: number;
}

export interface VerifiedDeliveryData {
  asOf: string;
  orders: StudioOrderRow[];
  checks: StudioCheckRow[];
  checkReasons: StudioCheckReasonRow[];
  cases: StudioCaseRow[];
  webhookEvents: StudioWebhookRow[];
  summary: VerifiedDeliverySummary;
}

export interface BarrierStoreRow {
  id: string;
  platform: string;
  status: string;
  productViolations: number | null;
  homeViolations: number | null;
  productCriticalOrSerious: number | null;
  keyboardOutcome: string;
  keyboardTested: number;
  keyboardReached: number;
  tabsToAddToCart: number | null;
  focusTrap: string;
  unnamedButtonsChecked: number;
  unnamedButtons: number;
}

export interface BarrierRuleRow {
  id: string;
  help: string;
  storesAffected: number;
  totalNodes: number;
}

export interface BarrierPlatformRow {
  id: string;
  platform: string;
  stores: number;
  crawled: number;
  blocked: number;
  medianViolationsProduct: number | null;
  medianViolationsHome: number | null;
  keyboardReachRate: number | null;
  keyboardReachDenominator: number;
}

export interface BarrierSummary {
  stores: number;
  crawled: number;
  blocked: number;
  medianViolationsProduct: number | null;
  keyboardTested: number;
  keyboardReached: number;
  unnamedChecked: number;
  unnamedStores: number;
  topRule: BarrierRuleRow | null;
  worstPlatform: { platform: string; medianViolationsProduct: number } | null;
}

export interface BarrierData {
  ranAt: string;
  gitSha: string;
  stores: BarrierStoreRow[];
  rules: BarrierRuleRow[];
  platforms: BarrierPlatformRow[];
  summary: BarrierSummary;
}

/** Which dashboard the assistant is answering for. The server picks its rules from this. */
export type StudioDashboardId = 'verified-delivery' | 'barrier-index';

/** What the client is told about the assistant. The key itself never leaves the server. */
export interface StudioAgentStatus {
  enabled: boolean;
  model: string | null;
}
