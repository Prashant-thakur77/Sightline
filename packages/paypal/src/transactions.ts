import { PayPalValidationError } from './errors';
import { parseWith, type HttpCore } from './http';
import { TransactionSearchSchema, type TransactionSearch } from './schemas';

/** Live docs: at most 31 days per query; history covers the previous three years. */
export const TRANSACTION_SEARCH_MAX_DAYS = 31;
export const TRANSACTION_SEARCH_HISTORY_YEARS = 3;

export interface TransactionSearchInput {
  startDate: Date | string;
  endDate: Date | string;
  /** 17 characters (19 for an order id). */
  transactionId?: string;
  /** D, P, S or V. */
  transactionStatus?: 'D' | 'P' | 'S' | 'V';
  /** Defaults to "all" so payer and cart details come back. */
  fields?: string;
  /** 1 to 500. */
  pageSize?: number;
  page?: number;
  balanceAffectingRecordsOnly?: boolean;
}

const DAY_MS = 86_400_000;

function toDate(v: Date | string, field: string): Date {
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) throw new PayPalValidationError(field, 'is not a valid date.');
  return d;
}

/** Validates the window and returns the query PayPal expects. Pure apart from `now`. */
export function buildTransactionQuery(
  input: TransactionSearchInput,
  nowMs: number,
): Record<string, string | number> {
  const start = toDate(input.startDate, 'startDate');
  const end = toDate(input.endDate, 'endDate');
  if (end.getTime() <= start.getTime())
    throw new PayPalValidationError('endDate', 'must be after startDate.');
  if (end.getTime() - start.getTime() > TRANSACTION_SEARCH_MAX_DAYS * DAY_MS)
    throw new PayPalValidationError(
      'endDate',
      `the range must be at most ${TRANSACTION_SEARCH_MAX_DAYS} days.`,
    );
  const earliest = new Date(nowMs);
  earliest.setUTCFullYear(earliest.getUTCFullYear() - TRANSACTION_SEARCH_HISTORY_YEARS);
  if (start.getTime() < earliest.getTime())
    throw new PayPalValidationError(
      'startDate',
      `must be within the last ${TRANSACTION_SEARCH_HISTORY_YEARS} years.`,
    );
  if (input.transactionId !== undefined && !/^[A-Za-z0-9]{17,19}$/.test(input.transactionId))
    throw new PayPalValidationError('transactionId', 'must be 17 to 19 letters and digits.');
  if (
    input.pageSize !== undefined &&
    (!Number.isInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 500)
  )
    throw new PayPalValidationError('pageSize', 'must be 1 to 500.');
  if (input.page !== undefined && (!Number.isInteger(input.page) || input.page < 1))
    throw new PayPalValidationError('page', 'must be at least 1.');

  const q: Record<string, string | number> = {
    start_date: start.toISOString(),
    end_date: end.toISOString(),
    fields: input.fields ?? 'all',
  };
  if (input.transactionId) q.transaction_id = input.transactionId;
  if (input.transactionStatus) q.transaction_status = input.transactionStatus;
  if (input.pageSize) q.page_size = input.pageSize;
  if (input.page) q.page = input.page;
  if (input.balanceAffectingRecordsOnly !== undefined)
    q.balance_affecting_records_only = input.balanceAffectingRecordsOnly ? 'Y' : 'N';
  return q;
}

/** GET /v1/reporting/transactions. Transactions can take up to three hours to appear. */
export async function searchTransactions(
  http: HttpCore,
  input: TransactionSearchInput,
  headers?: Record<string, string>,
): Promise<TransactionSearch> {
  const path = '/v1/reporting/transactions';
  const res = await http.request({
    method: 'GET',
    path,
    query: buildTransactionQuery(input, http.now()),
    headers,
  });
  return parseWith(TransactionSearchSchema, res, path);
}
