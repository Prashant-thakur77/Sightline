import { toDecimalString, type Money } from '@sightline/core';
import { PayPalValidationError } from './errors';
import { assertRequestId, parseWith, pathId, type HttpCore } from './http';
import {
  AuthorizationSchema,
  CaptureSchema,
  RefundSchema,
  type Authorization,
  type Capture,
  type Refund,
} from './schemas';

function amount(m: Money, field: string): { currency_code: string; value: string } {
  if (!Number.isInteger(m.cents) || m.cents <= 0)
    throw new PayPalValidationError(field, 'must be positive integer cents.');
  return { currency_code: m.currency, value: toDecimalString(m) };
}

function maxLen(value: string | undefined, max: number, field: string): void {
  if (value !== undefined && (value.length < 1 || value.length > max))
    throw new PayPalValidationError(field, `must be 1 to ${max} characters.`);
}

export interface CaptureAuthorizationInput {
  requestId: string;
  /** Omit to capture the full authorized amount. */
  amount?: Money;
  /** Defaults to true: Sightline captures once, after the item checks out. */
  finalCapture?: boolean;
  invoiceId?: string;
  noteToPayer?: string;
}

export interface RefundInput {
  requestId: string;
  /** Omit for a full refund. */
  amount?: Money;
  noteToPayer?: string;
  invoiceId?: string;
  customId?: string;
}

export function paymentsApi(http: HttpCore) {
  const auths = '/v2/payments/authorizations';
  const captures = '/v2/payments/captures';
  return {
    async getAuthorization(authorizationId: string): Promise<Authorization> {
      const path = `${auths}/${pathId(authorizationId, 'authorizationId')}`;
      return parseWith(AuthorizationSchema, await http.request({ method: 'GET', path }), path);
    },

    async captureAuthorization(authorizationId: string, input: CaptureAuthorizationInput): Promise<Capture> {
      const path = `${auths}/${pathId(authorizationId, 'authorizationId')}/capture`;
      maxLen(input.invoiceId, 127, 'invoiceId');
      maxLen(input.noteToPayer, 255, 'noteToPayer');
      const json: Record<string, unknown> = { final_capture: input.finalCapture ?? true };
      if (input.amount) json.amount = amount(input.amount, 'amount');
      if (input.invoiceId) json.invoice_id = input.invoiceId;
      if (input.noteToPayer) json.note_to_payer = input.noteToPayer;
      const res = await http.request({
        method: 'POST',
        path,
        json,
        requestId: assertRequestId(input.requestId),
        representation: true,
      });
      return parseWith(CaptureSchema, res, path);
    },

    /**
     * Voids an authorization (the item failed the check, or the buyer cancelled). With
     * `Prefer: return=representation` PayPal answers 200 with the authorization; a 204 returns undefined.
     */
    async voidAuthorization(
      authorizationId: string,
      opts: { requestId: string },
    ): Promise<Authorization | undefined> {
      const path = `${auths}/${pathId(authorizationId, 'authorizationId')}/void`;
      const res = await http.request({
        method: 'POST',
        path,
        requestId: assertRequestId(opts.requestId),
        representation: true,
      });
      return res.body === undefined ? undefined : parseWith(AuthorizationSchema, res, path);
    },

    async reauthorize(
      authorizationId: string,
      input: { requestId: string; amount?: Money },
    ): Promise<Authorization> {
      const path = `${auths}/${pathId(authorizationId, 'authorizationId')}/reauthorize`;
      const res = await http.request({
        method: 'POST',
        path,
        json: input.amount ? { amount: amount(input.amount, 'amount') } : {},
        requestId: assertRequestId(input.requestId),
        representation: true,
      });
      return parseWith(AuthorizationSchema, res, path);
    },

    async getCapture(captureId: string): Promise<Capture> {
      const path = `${captures}/${pathId(captureId, 'captureId')}`;
      return parseWith(CaptureSchema, await http.request({ method: 'GET', path }), path);
    },

    async refundCapture(captureId: string, input: RefundInput): Promise<Refund> {
      const path = `${captures}/${pathId(captureId, 'captureId')}/refund`;
      maxLen(input.noteToPayer, 255, 'noteToPayer');
      maxLen(input.invoiceId, 127, 'invoiceId');
      maxLen(input.customId, 127, 'customId');
      const json: Record<string, unknown> = {};
      if (input.amount) json.amount = amount(input.amount, 'amount');
      if (input.noteToPayer) json.note_to_payer = input.noteToPayer;
      if (input.invoiceId) json.invoice_id = input.invoiceId;
      if (input.customId) json.custom_id = input.customId;
      const res = await http.request({
        method: 'POST',
        path,
        json,
        requestId: assertRequestId(input.requestId),
        representation: true,
      });
      return parseWith(RefundSchema, res, path);
    },

    async getRefund(refundId: string): Promise<Refund> {
      const path = `/v2/payments/refunds/${pathId(refundId, 'refundId')}`;
      return parseWith(RefundSchema, await http.request({ method: 'GET', path }), path);
    },
  };
}

export type PaymentsApi = ReturnType<typeof paymentsApi>;
