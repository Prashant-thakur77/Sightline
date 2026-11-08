import type { CheckModule, ShippedVariant, Verdict } from '@sightline/core';
import type { DisputeReason } from './disputes';

/** What went wrong, in Sightline's words. */
export type SightlineIssue =
  | 'wrong_colour'
  | 'wrong_size'
  | 'wrong_model'
  | 'damaged'
  | 'never_arrived'
  | 'charged_twice'
  | 'wrong_amount';

export interface DisputeReasonMapping {
  reason: DisputeReason;
  /** merchandize_dispute_properties.issue_type; set for item problems. */
  issueType?: 'PRODUCT';
}

const MAP: Record<SightlineIssue, DisputeReasonMapping> = {
  wrong_colour: { reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED', issueType: 'PRODUCT' },
  wrong_size: { reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED', issueType: 'PRODUCT' },
  wrong_model: { reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED', issueType: 'PRODUCT' },
  damaged: { reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED', issueType: 'PRODUCT' },
  never_arrived: { reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', issueType: 'PRODUCT' },
  charged_twice: { reason: 'DUPLICATE_TRANSACTION' },
  wrong_amount: { reason: 'INCORRECT_AMOUNT' },
};

/** Sightline issue to PayPal dispute reason (codes checked against the live Disputes v1 enum). */
export function disputeReasonFor(issue: SightlineIssue): DisputeReasonMapping {
  return MAP[issue];
}

const MODULE_ISSUE: Partial<Record<CheckModule, SightlineIssue>> = {
  colour: 'wrong_colour',
  size: 'wrong_size',
  identity: 'wrong_model',
  damage: 'damaged',
};

/** The issue behind a mismatch verdict: the first module that disagreed. Photo quality never opens a case. */
export function issueFromVerdict(verdict: Verdict): SightlineIssue | undefined {
  if (verdict.kind !== 'mismatch') return undefined;
  for (const r of verdict.reasons) {
    const issue = r.finding === 'disagree' ? MODULE_ISSUE[r.module] : undefined;
    if (issue) return issue;
  }
  return undefined;
}

/** Demo-store shipped variant to the issue it represents. */
export function issueFromShippedVariant(variant: ShippedVariant): SightlineIssue | undefined {
  switch (variant) {
    case 'wrong_colour':
      return 'wrong_colour';
    case 'wrong_size':
      return 'wrong_size';
    case 'damaged':
      return 'damaged';
    case 'nothing':
      return 'never_arrived';
    default:
      return undefined;
  }
}
