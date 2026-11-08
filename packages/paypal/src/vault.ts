import { PayPalValidationError } from './errors';
import { parseWith, pathId, type HttpCore } from './http';
import {
  PaymentTokenListSchema,
  PaymentTokenSchema,
  type PaymentToken,
  type PaymentTokenList,
} from './schemas';

export interface ListPaymentTokensInput {
  /** PayPal-generated customer id (7 to 36 characters). */
  customerId: string;
  /** 1 to 5 (PayPal's limit). */
  pageSize?: number;
  /** 1 to 10. */
  page?: number;
  totalRequired?: boolean;
}

export function vaultApi(http: HttpCore) {
  const base = '/v3/vault/payment-tokens';
  return {
    async getPaymentToken(tokenId: string): Promise<PaymentToken> {
      const path = `${base}/${pathId(tokenId, 'tokenId')}`;
      return parseWith(PaymentTokenSchema, await http.request({ method: 'GET', path }), path);
    },

    /** Deletes a saved payment method. PayPal answers 204. */
    async deletePaymentToken(tokenId: string): Promise<void> {
      await http.request({ method: 'DELETE', path: `${base}/${pathId(tokenId, 'tokenId')}` });
    },

    async listPaymentTokens(input: ListPaymentTokensInput): Promise<PaymentTokenList> {
      if (!/^[0-9a-zA-Z_-]{7,36}$/.test(input.customerId))
        throw new PayPalValidationError('customerId', 'must be a PayPal customer id (7 to 36 characters).');
      if (
        input.pageSize !== undefined &&
        (!Number.isInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 5)
      )
        throw new PayPalValidationError('pageSize', 'must be 1 to 5.');
      if (input.page !== undefined && (!Number.isInteger(input.page) || input.page < 1 || input.page > 10))
        throw new PayPalValidationError('page', 'must be 1 to 10.');
      const res = await http.request({
        method: 'GET',
        path: base,
        query: {
          customer_id: input.customerId,
          page_size: input.pageSize,
          page: input.page,
          total_required: input.totalRequired,
        },
      });
      return parseWith(PaymentTokenListSchema, res, base);
    },
  };
}

export type VaultApi = ReturnType<typeof vaultApi>;
