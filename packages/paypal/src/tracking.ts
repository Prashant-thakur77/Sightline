import { PayPalApiError, PayPalValidationError } from './errors';
import { parseWith, pathId, type HttpCore } from './http';
import {
  BatchTrackerResponseSchema,
  OrderSchema,
  TrackerCollectionSchema,
  type BatchTrackerResponse,
  type Order,
  type TrackerCollection,
} from './schemas';
import { paypalImageUrl } from './orders';

/**
 * "orders-track": POST /v2/checkout/orders/{id}/track (live docs: the path for Orders v2 integrations).
 * "trackers-batch": POST /v1/shipping/trackers-batch (Add Tracking API, documented for legacy integrations).
 * Spike S3 decides which one Sightline keeps; both stay behind this one function.
 */
export type TrackingStrategy = 'orders-track' | 'trackers-batch';

export interface TrackerItemInput {
  name?: string;
  quantity?: number;
  sku?: string;
  url?: string;
  imageUrl?: string;
}

export interface AddTrackingInput {
  strategy: TrackingStrategy;
  /** Required for "orders-track". */
  orderId?: string;
  /** The capture id; the Add Tracking API calls it transaction_id. */
  captureId: string;
  trackingNumber: string;
  /** PayPal carrier code, e.g. "USPS", "UPS", "FEDEX", or "OTHER" with carrierNameOther. */
  carrier: string;
  carrierNameOther?: string;
  /** Email the buyer the tracking details. Defaults to false. */
  notifyPayer?: boolean;
  /** "orders-track" only: which items are in this parcel. */
  items?: TrackerItemInput[];
  /** "trackers-batch" only. Defaults to SHIPPED. */
  status?: string;
  /** "trackers-batch" only, YYYY-MM-DD. */
  shipmentDate?: string;
  requestId?: string;
}

export interface AddTrackingResult {
  strategy: TrackingStrategy;
  /** `${captureId}-${trackingNumber}` in both APIs. */
  trackerId: string | undefined;
  order?: Order;
  batch?: BatchTrackerResponse;
}

function validate(input: AddTrackingInput): void {
  if (input.strategy !== 'orders-track' && input.strategy !== 'trackers-batch')
    throw new PayPalValidationError('strategy', 'must be "orders-track" or "trackers-batch".');
  pathId(input.captureId, 'captureId');
  if (!input.trackingNumber || input.trackingNumber.length > 64)
    throw new PayPalValidationError('trackingNumber', 'must be 1 to 64 characters.');
  if (!input.carrier) throw new PayPalValidationError('carrier', 'is required.');
  if (input.carrier === 'OTHER' && !input.carrierNameOther)
    throw new PayPalValidationError('carrierNameOther', 'is required when carrier is OTHER.');
  if (input.strategy === 'orders-track' && !input.orderId)
    throw new PayPalValidationError('orderId', 'is required for the orders-track strategy.');
}

export function buildOrderTrackBody(input: AddTrackingInput): Record<string, unknown> {
  return {
    capture_id: input.captureId,
    tracking_number: input.trackingNumber,
    carrier: input.carrier,
    ...(input.carrierNameOther ? { carrier_name_other: input.carrierNameOther } : {}),
    notify_payer: input.notifyPayer ?? false,
    ...(input.items?.length
      ? {
          items: input.items.map((i) => ({
            ...(i.name ? { name: i.name } : {}),
            ...(i.quantity !== undefined ? { quantity: String(i.quantity) } : {}),
            ...(i.sku ? { sku: i.sku } : {}),
            ...(i.url ? { url: i.url } : {}),
            ...(paypalImageUrl(i.imageUrl) ? { image_url: paypalImageUrl(i.imageUrl) } : {}),
          })),
        }
      : {}),
  };
}

export function buildTrackersBatchBody(input: AddTrackingInput): Record<string, unknown> {
  return {
    trackers: [
      {
        transaction_id: input.captureId,
        tracking_number: input.trackingNumber,
        status: input.status ?? 'SHIPPED',
        carrier: input.carrier,
        ...(input.carrierNameOther ? { carrier_name_other: input.carrierNameOther } : {}),
        notify_buyer: input.notifyPayer ?? false,
        ...(input.shipmentDate ? { shipment_date: input.shipmentDate } : {}),
      },
    ],
  };
}

export function trackingApi(http: HttpCore) {
  return {
    async addTracking(input: AddTrackingInput): Promise<AddTrackingResult> {
      validate(input);
      const expectedId = `${input.captureId}-${input.trackingNumber}`;
      if (input.strategy === 'orders-track') {
        const path = `/v2/checkout/orders/${pathId(input.orderId, 'orderId')}/track`;
        const res = await http.request({
          method: 'POST',
          path,
          json: buildOrderTrackBody(input),
          requestId: input.requestId,
        });
        const order = parseWith(OrderSchema, res, path);
        const trackers = order.purchase_units?.flatMap((u) => u.shipping?.trackers ?? []) ?? [];
        const tracker = trackers.find((t) => t.id === expectedId) ?? trackers.at(-1);
        return { strategy: input.strategy, trackerId: tracker?.id, order };
      }
      const path = '/v1/shipping/trackers-batch';
      const res = await http.request({
        method: 'POST',
        path,
        json: buildTrackersBatchBody(input),
        requestId: input.requestId,
      });
      const batch = parseWith(BatchTrackerResponseSchema, res, path);
      // The batch API answers 200 even when an entry failed; surface that as an error.
      const first = batch.errors[0];
      if (first) {
        throw new PayPalApiError({
          status: res.status,
          name: first.name ?? 'TRACKER_ERROR',
          message: first.message ?? 'PayPal rejected the tracker.',
          debugId: first.debug_id ?? res.debugId,
          details: first.details ?? [],
          method: 'POST',
          path,
          requestId: res.requestId,
        });
      }
      const ident = batch.tracker_identifiers.find((t) => t.transaction_id === input.captureId);
      const trackerId = ident ? `${ident.transaction_id}-${ident.tracking_number ?? 'NOTRACKER'}` : undefined;
      return { strategy: input.strategy, trackerId, batch };
    },

    /** Lists trackers for a capture (Add Tracking API). Used to poll delivery when no webhook arrives. */
    async getTrackers(input: { transactionId: string; trackingNumber?: string }): Promise<TrackerCollection> {
      const path = '/v1/shipping/trackers';
      const res = await http.request({
        method: 'GET',
        path,
        query: {
          transaction_id: pathId(input.transactionId, 'transactionId'),
          tracking_number: input.trackingNumber,
        },
      });
      return parseWith(TrackerCollectionSchema, res, path);
    },
  };
}

export type TrackingApi = ReturnType<typeof trackingApi>;
