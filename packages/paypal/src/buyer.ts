import type { Money } from '@sightline/core';
import { PayPalResponseShapeError, PayPalValidationError } from './errors';
import { fileParts, validateEvidenceFiles, type EvidenceFile } from './files';
import { idFromSelfLink } from './hateoas';
import { assertRequestId, parseWith, type HttpCore } from './http';
import {
  DISPUTE_REASONS,
  disputeAction,
  listDisputes,
  moneyField,
  note,
  resolveDispute,
  type ActionContext,
  type DisputeReason,
  type DisputeRef,
  type ListDisputesInput,
} from './disputes';
import { encodeMultipart } from './multipart';
import { SubsequentActionSchema, type SubsequentAction } from './schemas';
import { searchTransactions, type TransactionSearchInput } from './transactions';

function base64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export type AuthAssertionSubject = { email: string; payerId?: never } | { payerId: string; email?: never };

/**
 * Unsigned JWT for the PayPal-Auth-Assertion header: header {"alg":"none","typ":"JWT"}, payload
 * {"iss": clientId, "email": buyerEmail} (the live disputes sandbox docs) or {"iss", "payer_id"}, and an
 * empty signature, so the token ends with ".".
 */
export function buildAuthAssertion(clientId: string, subject: AuthAssertionSubject): string {
  if (!clientId) throw new PayPalValidationError('clientId', 'is required.');
  const payload: Record<string, string> = { iss: clientId };
  if ('email' in subject && subject.email) payload.email = subject.email;
  else if ('payerId' in subject && subject.payerId) payload.payer_id = subject.payerId;
  else throw new PayPalValidationError('subject', 'needs the buyer email or payer id.');
  return `${base64url(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${base64url(JSON.stringify(payload))}.`;
}

export type MerchantContactedOutcome = 'NO_RESPONSE' | 'FIXED' | 'RESPONDED' | 'NOT_FIXED';

export interface CreateBuyerDisputeInput {
  /** The buyer-side transaction id (spike S1 decides where it comes from). */
  buyerTransactionId: string;
  reason: DisputeReason;
  /** At most the transaction amount. */
  disputeAmount: Money;
  merchantContacted?: boolean;
  merchantContactedOutcome?: MerchantContactedOutcome;
  /** PRODUCT for physical goods. */
  issueType?: 'PRODUCT' | 'SERVICE';
  /** The buyer's description. Sent as evidences[0].notes, the place the live docs use. */
  notes?: string;
  files?: EvidenceFile[];
  requestId?: string;
}

export interface CreatedDispute {
  disputeId: string;
  links: SubsequentAction['links'];
}

/** Builds the `input` JSON for POST /v1/customer/disputes. Pure. */
export function buildCreateDisputeInput(input: CreateBuyerDisputeInput): Record<string, unknown> {
  if (!/^[A-Za-z0-9-]{1,255}$/.test(input.buyerTransactionId))
    throw new PayPalValidationError('buyerTransactionId', 'must be a PayPal transaction id.');
  if (!DISPUTE_REASONS.includes(input.reason))
    throw new PayPalValidationError('reason', 'is not a PayPal dispute reason.');
  const extensions: Record<string, unknown> = {};
  if (input.merchantContacted !== undefined) extensions.merchant_contacted = input.merchantContacted;
  if (input.merchantContactedOutcome) extensions.merchant_contacted_outcome = input.merchantContactedOutcome;
  if (input.issueType) extensions.merchandize_dispute_properties = { issue_type: input.issueType };
  const body: Record<string, unknown> = {
    disputed_transactions: [{ buyer_transaction_id: input.buyerTransactionId }],
    reason: input.reason,
    dispute_amount: moneyField(input.disputeAmount, 'disputeAmount'),
  };
  if (Object.keys(extensions).length) body.extensions = extensions;
  const n = note(input.notes, 'notes', false);
  if (n) body.evidences = [{ notes: n }];
  return body;
}

/**
 * Buyer-side dispute calls (sandbox simulation). Every call carries PayPal-Auth-Assertion identifying the buyer.
 * Create and change-reason are limited-release and need the disputes/create and disputes/update-buyer scopes
 * plus buyer consent through Log in with PayPal.
 */
export function buyerApi(http: HttpCore, authAssertion: string) {
  const headers = { 'PayPal-Auth-Assertion': authAssertion };
  const ctx: ActionContext = { http, headers };
  return {
    authAssertion,

    async create(input: CreateBuyerDisputeInput): Promise<CreatedDispute> {
      const json = buildCreateDisputeInput(input);
      if (input.files?.length) validateEvidenceFiles(input.files);
      const mp = encodeMultipart([
        { name: 'input', contentType: 'application/json', value: JSON.stringify(json) },
        ...fileParts(input.files ?? []),
      ]);
      const path = '/v1/customer/disputes';
      const res = await http.request({
        method: 'POST',
        path,
        raw: { body: mp.body, contentType: mp.contentType },
        headers,
        requestId: input.requestId,
      });
      const body = parseWith(SubsequentActionSchema, res, path);
      const disputeId = idFromSelfLink(body);
      if (!disputeId) throw new PayPalResponseShapeError(path, ['no dispute link in response'], res.debugId);
      return { disputeId, links: body.links };
    },

    get: (disputeId: string) => resolveDispute(ctx, disputeId),
    list: (input?: ListDisputesInput) => listDisputes(ctx, input),

    /** Sandbox only. Multipart with an `input` part, as in the live docs. Not link-gated: PayPal documents no link for it. */
    async changeReason(
      ref: DisputeRef,
      input: {
        reason: DisputeReason;
        note?: string;
        itemInfo?: Record<string, unknown>[];
        requestId?: string;
      },
    ) {
      if (!DISPUTE_REASONS.includes(input.reason))
        throw new PayPalValidationError('reason', 'is not a PayPal dispute reason.');
      const json: Record<string, unknown> = { reason: input.reason };
      const n = note(input.note, 'note', false);
      if (n) json.note = n;
      if (input.itemInfo?.length) json.item_info = input.itemInfo;
      return disputeAction(ctx, ref, {
        action: 'change-reason',
        json,
        alwaysMultipart: true,
        ungated: true,
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

    /** PayPal refunds the offered amount when the buyer accepts. Money-moving: a request id is required. */
    async acceptOffer(ref: DisputeRef, input: { requestId: string; note?: string }) {
      const requestId = assertRequestId(input.requestId);
      const n = note(input.note, 'note', false);
      return disputeAction(ctx, ref, { action: 'accept-offer', json: n ? { note: n } : {}, requestId });
    },

    async denyOffer(ref: DisputeRef, input: { note: string; requestId?: string }) {
      return disputeAction(ctx, ref, {
        action: 'deny-offer',
        json: { note: note(input.note, 'note', true) },
        requestId: input.requestId,
      });
    },

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

    async escalate(ref: DisputeRef, input: { note: string; requestId?: string }) {
      return disputeAction(ctx, ref, {
        action: 'escalate',
        json: { note: note(input.note, 'note', true) },
        requestId: input.requestId,
      });
    },

    /** Transaction Search with the buyer's assertion. Not documented for buyers: spike S1 checks whether it works. */
    searchTransactions: (input: TransactionSearchInput) => searchTransactions(http, input, headers),
  };
}

export type BuyerApi = ReturnType<typeof buyerApi>;
