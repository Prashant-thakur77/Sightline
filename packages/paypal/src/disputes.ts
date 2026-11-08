import { toDecimalString, type Money } from '@sightline/core';
import { PayPalActionUnavailableError, PayPalValidationError } from './errors';
import { fileParts, validateEvidenceFiles, type EvidenceFile } from './files';
import { requireAction } from './hateoas';
import { assertRequestId, parseWith, pathId, type HttpCore, type RequestSpec } from './http';
import { encodeMultipart } from './multipart';
import {
  DisputeListSchema,
  DisputeSchema,
  SubsequentActionSchema,
  type Dispute,
  type DisputeList,
  type SubsequentAction,
} from './schemas';

export const DISPUTE_REASONS = [
  'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
  'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED',
  'UNAUTHORISED',
  'CREDIT_NOT_PROCESSED',
  'DUPLICATE_TRANSACTION',
  'INCORRECT_AMOUNT',
  'PAYMENT_BY_OTHER_MEANS',
  'CANCELED_RECURRING_BILLING',
  'PROBLEM_WITH_REMITTANCE',
  'OTHER',
] as const;
export type DisputeReason = (typeof DISPUTE_REASONS)[number];

export const DISPUTE_STATES = [
  'OPEN_INQUIRIES',
  'REQUIRED_ACTION',
  'REQUIRED_OTHER_PARTY_ACTION',
  'UNDER_PAYPAL_REVIEW',
  'APPEALABLE',
  'RESOLVED',
] as const;
export type DisputeState = (typeof DISPUTE_STATES)[number];

export const OFFER_TYPES = [
  'REFUND',
  'REFUND_WITH_RETURN',
  'REFUND_WITH_REPLACEMENT',
  'REPLACEMENT_WITHOUT_REFUND',
] as const;
export type OfferType = (typeof OFFER_TYPES)[number];

export type AcceptClaimType =
  'REFUND' | 'REFUND_WITH_RETURN' | 'PARTIAL_REFUND' | 'REFUND_WITH_RETURN_SHIPMENT_LABEL';
export type AcknowledgementType =
  'ITEM_RECEIVED' | 'ITEM_NOT_RECEIVED' | 'DAMAGED' | 'EMPTY_PACKAGE_OR_DIFFERENT' | 'MISSING_ITEMS';
export type AdjudicationOutcome = 'BUYER_FAVOR' | 'SELLER_FAVOR';
export type RequireEvidenceAction = 'BUYER_EVIDENCE' | 'SELLER_EVIDENCE';

/** PayPal address_portable, snake_case as sent. */
export interface PortableAddress {
  address_line_1?: string;
  address_line_2?: string;
  admin_area_1?: string;
  admin_area_2?: string;
  postal_code?: string;
  country_code: string;
}

/** One evidence entry as PayPal expects it inside the multipart `input` JSON. */
export interface EvidenceInput {
  evidence_type: string;
  evidence_info?: {
    tracking_info?: { carrier_name: string; tracking_number: string; carrier_name_other?: string }[];
    refund_ids?: string[];
  };
  notes?: string;
  documents?: { name: string }[];
  item_id?: string;
}

/** A dispute id, or a dispute already fetched (its links decide which actions are allowed). */
export type DisputeRef = string | Dispute;

export function moneyField(m: Money, field: string): { currency_code: string; value: string } {
  if (!Number.isInteger(m.cents) || m.cents <= 0)
    throw new PayPalValidationError(field, 'must be positive integer cents.');
  return { currency_code: m.currency, value: toDecimalString(m) };
}

export function note(value: string | undefined, field: string, required: boolean): string | undefined {
  if (value === undefined || value === '') {
    if (required) throw new PayPalValidationError(field, 'is required.');
    return undefined;
  }
  if (value.length > 2000) throw new PayPalValidationError(field, 'must be at most 2000 characters.');
  return value;
}

export interface ActionContext {
  http: HttpCore;
  /** Extra headers on every call, e.g. PayPal-Auth-Assertion for the buyer side. */
  headers?: Record<string, string>;
}

/** Fetches the dispute when only an id is given, so HATEOAS gating always runs on fresh links. */
export async function resolveDispute(ctx: ActionContext, ref: DisputeRef): Promise<Dispute> {
  if (typeof ref !== 'string') return ref;
  const path = `/v1/customer/disputes/${pathId(ref, 'disputeId')}`;
  return parseWith(
    DisputeSchema,
    await ctx.http.request({ method: 'GET', path, headers: ctx.headers }),
    path,
  );
}

export interface ActionCall {
  action: string;
  json: Record<string, unknown>;
  files?: readonly EvidenceFile[];
  /** Always send multipart with an `input` part, even without files. */
  alwaysMultipart?: boolean;
  requestId?: string;
  /** Checked against the dispute's `allowed_response_options` before sending. */
  allowed?: { pick: (d: Dispute) => string[] | undefined; value: string | undefined; field: string };
  /** Skip link gating (only for documented actions that PayPal does not advertise as a link). */
  ungated?: boolean;
}

/** Gate on the dispute's links (and allowed options), then POST the action. Nothing is sent when gating fails. */
export async function disputeAction(
  ctx: ActionContext,
  ref: DisputeRef,
  call: ActionCall,
): Promise<SubsequentAction> {
  if (call.files?.length) validateEvidenceFiles(call.files);
  const dispute = await resolveDispute(ctx, ref);
  if (!call.ungated) requireAction(dispute, call.action, dispute.dispute_id);
  const allowedList = call.allowed ? call.allowed.pick(dispute) : undefined;
  if (call.allowed?.value !== undefined && allowedList && !allowedList.includes(call.allowed.value))
    throw new PayPalActionUnavailableError(
      call.action,
      dispute.dispute_id,
      allowedList,
      `${call.allowed.field} "${call.allowed.value}" is not allowed for this dispute.`,
    );
  const path = `/v1/customer/disputes/${pathId(dispute.dispute_id, 'disputeId')}/${call.action}`;
  const spec: RequestSpec = { method: 'POST', path, requestId: call.requestId, headers: ctx.headers };
  if (call.files?.length || call.alwaysMultipart) {
    const mp = encodeMultipart([
      { name: 'input', contentType: 'application/json', value: JSON.stringify(call.json) },
      ...fileParts(call.files ?? []),
    ]);
    spec.raw = { body: mp.body, contentType: mp.contentType };
  } else {
    spec.json = call.json;
  }
  return parseWith(SubsequentActionSchema, await ctx.http.request(spec), path);
}

export interface ListDisputesInput {
  disputedTransactionId?: string;
  disputeState?: DisputeState | DisputeState[];
  createTimeAfter?: string;
  createTimeBefore?: string;
  updateTimeAfter?: string;
  updateTimeBefore?: string;
  /** 1 to 50. */
  page?: number;
  /** 1 to 50. */
  pageSize?: number;
}

export async function listDisputes(ctx: ActionContext, input: ListDisputesInput = {}): Promise<DisputeList> {
  for (const k of ['page', 'pageSize'] as const) {
    const v = input[k];
    if (v !== undefined && (!Number.isInteger(v) || v < 1 || v > 50))
      throw new PayPalValidationError(k, 'must be 1 to 50.');
  }
  const states =
    input.disputeState === undefined ? undefined : ([] as string[]).concat(input.disputeState).join(',');
  const path = '/v1/customer/disputes';
  const res = await ctx.http.request({
    method: 'GET',
    path,
    headers: ctx.headers,
    query: {
      disputed_transaction_id: input.disputedTransactionId,
      dispute_state: states,
      create_time_after: input.createTimeAfter,
      create_time_before: input.createTimeBefore,
      update_time_after: input.updateTimeAfter,
      update_time_before: input.updateTimeBefore,
      page: input.page,
      page_size: input.pageSize,
    },
  });
  return parseWith(DisputeListSchema, res, path);
}

// ---- Merchant side ----

export interface MakeOfferInput {
  requestId: string;
  offerType: OfferType;
  note: string;
  offerAmount?: Money;
  returnShippingAddress?: PortableAddress;
  invoiceId?: string;
}

export interface AcceptClaimInput {
  requestId: string;
  note: string;
  acceptClaimType?: AcceptClaimType;
  acceptClaimReason?: string;
  refundAmount?: Money;
  returnShippingAddress?: PortableAddress;
  invoiceId?: string;
}

export function merchantDisputesApi(http: HttpCore) {
  const ctx: ActionContext = { http };
  return {
    list: (input?: ListDisputesInput) => listDisputes(ctx, input),
    get: (disputeId: string) => resolveDispute(ctx, disputeId),

    async sendMessage(
      ref: DisputeRef,
      input: { message: string; files?: EvidenceFile[]; requestId?: string },
    ) {
      return disputeAction(ctx, ref, {
        action: 'send-message',
        json: { message: note(input.message, 'message', true) },
        files: input.files,
        requestId: input.requestId,
      });
    },

    async makeOffer(ref: DisputeRef, input: MakeOfferInput) {
      const requestId = assertRequestId(input.requestId);
      if (!OFFER_TYPES.includes(input.offerType))
        throw new PayPalValidationError('offerType', `must be one of ${OFFER_TYPES.join(', ')}.`);
      if (input.offerType !== 'REPLACEMENT_WITHOUT_REFUND' && !input.offerAmount)
        throw new PayPalValidationError('offerAmount', `is required for ${input.offerType}.`);
      if (input.offerType === 'REFUND_WITH_RETURN' && !input.returnShippingAddress)
        throw new PayPalValidationError('returnShippingAddress', 'is required for REFUND_WITH_RETURN.');
      const json: Record<string, unknown> = {
        note: note(input.note, 'note', true),
        offer_type: input.offerType,
      };
      if (input.offerAmount) json.offer_amount = moneyField(input.offerAmount, 'offerAmount');
      if (input.returnShippingAddress) json.return_shipping_address = input.returnShippingAddress;
      if (input.invoiceId) json.invoice_id = input.invoiceId;
      return disputeAction(ctx, ref, {
        action: 'make-offer',
        json,
        requestId,
        allowed: {
          pick: (d) => d.allowed_response_options?.make_offer?.offer_types,
          value: input.offerType,
          field: 'offer_type',
        },
      });
    },

    /** Accepting a claim refunds the buyer. Callers must have a person confirm first; this never runs on its own. */
    async acceptClaim(ref: DisputeRef, input: AcceptClaimInput) {
      const requestId = assertRequestId(input.requestId);
      const json: Record<string, unknown> = { note: note(input.note, 'note', true) };
      if (input.acceptClaimType) json.accept_claim_type = input.acceptClaimType;
      if (input.acceptClaimReason) json.accept_claim_reason = input.acceptClaimReason;
      if (input.refundAmount) json.refund_amount = moneyField(input.refundAmount, 'refundAmount');
      if (input.returnShippingAddress) json.return_shipping_address = input.returnShippingAddress;
      if (input.invoiceId) json.invoice_id = input.invoiceId;
      return disputeAction(ctx, ref, {
        action: 'accept-claim',
        json,
        requestId,
        allowed: {
          pick: (d) => d.allowed_response_options?.accept_claim?.accept_claim_types,
          value: input.acceptClaimType,
          field: 'accept_claim_type',
        },
      });
    },

    /** Always multipart: an `input` JSON part with `evidences`, plus file1..fileN. */
    async provideEvidence(
      ref: DisputeRef,
      input: { evidences: EvidenceInput[]; files?: EvidenceFile[]; requestId?: string },
    ) {
      if (!input.evidences.length)
        throw new PayPalValidationError('evidences', 'at least one evidence entry is required.');
      return disputeAction(ctx, ref, {
        action: 'provide-evidence',
        json: { evidences: input.evidences },
        files: input.files,
        alwaysMultipart: true,
        requestId: input.requestId,
      });
    },

    async escalate(ref: DisputeRef, input: { note: string; requestId?: string }) {
      return disputeAction(ctx, ref, {
        action: 'escalate',
        json: { note: note(input.note, 'note', true) },
        requestId: input.requestId,
      });
    },

    async acknowledgeReturnItem(
      ref: DisputeRef,
      input: {
        note?: string;
        acknowledgementType?: AcknowledgementType;
        files?: EvidenceFile[];
        requestId?: string;
      },
    ) {
      const json: Record<string, unknown> = {};
      const n = note(input.note, 'note', false);
      if (n) json.note = n;
      if (input.acknowledgementType) json.acknowledgement_type = input.acknowledgementType;
      return disputeAction(ctx, ref, {
        action: 'acknowledge-return-item',
        json,
        files: input.files,
        requestId: input.requestId,
        allowed: {
          pick: (d) => d.allowed_response_options?.acknowledge_return_item?.acknowledgement_types,
          value: input.acknowledgementType,
          field: 'acknowledgement_type',
        },
      });
    },

    async appeal(
      ref: DisputeRef,
      input: { evidences: EvidenceInput[]; files?: EvidenceFile[]; requestId?: string },
    ) {
      if (!input.evidences.length)
        throw new PayPalValidationError('evidences', 'at least one evidence entry is required.');
      return disputeAction(ctx, ref, {
        action: 'appeal',
        json: { evidences: input.evidences },
        files: input.files,
        alwaysMultipart: true,
        requestId: input.requestId,
      });
    },

    async provideSupportingInfo(
      ref: DisputeRef,
      input: { notes: string; files?: EvidenceFile[]; requestId?: string },
    ) {
      return disputeAction(ctx, ref, {
        action: 'provide-supporting-info',
        json: { notes: note(input.notes, 'notes', true) },
        files: input.files,
        requestId: input.requestId,
      });
    },
  };
}

/** Sandbox-only simulation endpoints. Both need status UNDER_REVIEW and the matching link. */
export function sandboxDisputesApi(http: HttpCore) {
  const ctx: ActionContext = { http };
  async function underReview(ref: DisputeRef, action: string): Promise<Dispute> {
    const d = await resolveDispute(ctx, ref);
    if (d.status !== undefined && d.status !== 'UNDER_REVIEW')
      throw new PayPalActionUnavailableError(
        action,
        d.dispute_id,
        (d.links ?? []).map((l) => l.rel),
        `Status is ${d.status}, not UNDER_REVIEW.`,
      );
    return d;
  }
  return {
    async adjudicate(ref: DisputeRef, outcome: AdjudicationOutcome, opts: { requestId?: string } = {}) {
      if (outcome !== 'BUYER_FAVOR' && outcome !== 'SELLER_FAVOR')
        throw new PayPalValidationError('outcome', 'must be BUYER_FAVOR or SELLER_FAVOR.');
      const d = await underReview(ref, 'adjudicate');
      return disputeAction(ctx, d, {
        action: 'adjudicate',
        json: { adjudication_outcome: outcome },
        requestId: opts.requestId,
      });
    },
    async requireEvidence(ref: DisputeRef, action: RequireEvidenceAction, opts: { requestId?: string } = {}) {
      if (action !== 'BUYER_EVIDENCE' && action !== 'SELLER_EVIDENCE')
        throw new PayPalValidationError('action', 'must be BUYER_EVIDENCE or SELLER_EVIDENCE.');
      const d = await underReview(ref, 'require-evidence');
      return disputeAction(ctx, d, {
        action: 'require-evidence',
        json: { action },
        requestId: opts.requestId,
      });
    },
  };
}

export type MerchantDisputesApi = ReturnType<typeof merchantDisputesApi>;
export type SandboxDisputesApi = ReturnType<typeof sandboxDisputesApi>;
