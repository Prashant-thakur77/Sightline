import { toDecimalString, type Money } from '@sightline/core';
import { PayPalValidationError } from './errors';
import { findLink } from './hateoas';
import { assertRequestId, parseWith, pathId, type HttpCore } from './http';
import { OrderSchema, type Authorization, type Capture, type Order } from './schemas';

/**
 * PayPal accepts an item image only as an https link ending in .jpg, .jpeg, .gif or .png, with no
 * query string (its documented pattern); anything else fails the whole order with
 * INVALID_PARAMETER_SYNTAX. Images from product feeds often have neither, so they are left out
 * rather than risk the payment. The image is decoration on PayPal's page; nothing depends on it.
 */
export function paypalImageUrl(url: string | undefined | null): string | undefined {
  if (!url || url.length > 2048) return undefined;
  return /^https:[/.\w\s-]+\.(jpe?g|gif|png)$/i.test(url) ? url : undefined;
}

/** Plan decision: custom_id carries the first 127 characters of the readback hash (PayPal allows 255). */
export const CUSTOM_ID_MAX_LENGTH = 127;
export const INVOICE_ID_MAX_LENGTH = 127;

export type OrderIntent = 'CAPTURE' | 'AUTHORIZE';
export type ItemCategory = 'PHYSICAL_GOODS' | 'DIGITAL_GOODS' | 'DONATION';

export interface OrderItemInput {
  name: string;
  quantity: number;
  unitAmount: Money;
  /** Tax per unit. When any item has tax, tax_total is the sum of tax x quantity. */
  tax?: Money;
  sku?: string;
  description?: string;
  url?: string;
  imageUrl?: string;
  /** Defaults to PHYSICAL_GOODS. */
  category?: ItemCategory;
}

export interface AddressInput {
  addressLine1: string;
  addressLine2?: string;
  /** City, town or village. */
  adminArea2: string;
  /** State or province code. */
  adminArea1?: string;
  postalCode?: string;
  countryCode: string;
}

export interface ExperienceContextInput {
  returnUrl?: string;
  cancelUrl?: string;
  brandName?: string;
  locale?: string;
  shippingPreference?: 'GET_FROM_FILE' | 'NO_SHIPPING' | 'SET_PROVIDED_ADDRESS';
  userAction?: 'CONTINUE' | 'PAY_NOW';
  landingPage?: 'LOGIN' | 'GUEST_CHECKOUT' | 'NO_PREFERENCE' | 'BILLING';
}

export type PaymentSourceInput =
  | {
      /** Buyer approves with PayPal. `storeInVault` saves the PayPal wallet after a successful capture or authorization. */
      type: 'paypal';
      experienceContext?: ExperienceContextInput;
      storeInVault?: boolean;
      /** PayPal customer id to link the new token to, for a payer who already has one. */
      customerId?: string;
    }
  | {
      /** Buyer-not-present payment with a vaulted PayPal wallet. */
      type: 'vault';
      vaultId: string;
      storedCredential?: {
        payment_initiator: 'CUSTOMER' | 'MERCHANT';
        usage: 'FIRST' | 'SUBSEQUENT' | 'DERIVED';
        usage_pattern?: string;
      };
    };

export interface OrderInput {
  intent: OrderIntent;
  items: OrderItemInput[];
  /** Shipping cost. */
  shipping?: Money;
  /** Order-level tax, only when items carry no per-item tax. */
  taxTotal?: Money;
  /** The total the buyer heard in the readback. The build fails if the computed total differs. */
  expectedTotal?: Money;
  /** Truncated to 127 characters. */
  customId?: string;
  invoiceId?: string;
  referenceId?: string;
  description?: string;
  payeeMerchantId?: string;
  shipTo?: { fullName: string; address: AddressInput };
  paymentSource?: PaymentSourceInput;
}

export interface CreateOrderInput extends OrderInput {
  requestId: string;
  /** PayPal-Client-Metadata-Id (risk data) for buyer-initiated vault payments. */
  clientMetadataId?: string;
}

type Json = Record<string, unknown>;

function amount(m: Money): { currency_code: string; value: string } {
  return { currency_code: m.currency, value: toDecimalString(m) };
}

function checkMoney(m: Money, currency: string, field: string): void {
  if (!Number.isInteger(m.cents)) throw new PayPalValidationError(field, 'must be integer cents.');
  if (m.cents < 0) throw new PayPalValidationError(field, 'must not be negative.');
  if (m.currency !== currency)
    throw new PayPalValidationError(field, `currency ${m.currency} differs from ${currency}.`);
}

function address(a: AddressInput): Json {
  return {
    address_line_1: a.addressLine1,
    ...(a.addressLine2 ? { address_line_2: a.addressLine2 } : {}),
    admin_area_2: a.adminArea2,
    ...(a.adminArea1 ? { admin_area_1: a.adminArea1 } : {}),
    ...(a.postalCode ? { postal_code: a.postalCode } : {}),
    country_code: a.countryCode,
  };
}

function experienceContext(e: ExperienceContextInput, hasShipTo: boolean): Json | undefined {
  const out: Json = {};
  if (e.brandName) out.brand_name = e.brandName;
  if (e.locale) out.locale = e.locale;
  const pref = e.shippingPreference ?? (hasShipTo ? 'SET_PROVIDED_ADDRESS' : undefined);
  if (pref) out.shipping_preference = pref;
  if (e.landingPage) out.landing_page = e.landingPage;
  if (e.userAction) out.user_action = e.userAction;
  if (e.returnUrl) out.return_url = e.returnUrl;
  if (e.cancelUrl) out.cancel_url = e.cancelUrl;
  return Object.keys(out).length ? out : undefined;
}

function paymentSource(ps: PaymentSourceInput, hasShipTo: boolean): Json {
  if (ps.type === 'vault') {
    if (!/^[0-9a-zA-Z_-]{1,255}$/.test(ps.vaultId))
      throw new PayPalValidationError('paymentSource.vaultId', 'is not a vault id.');
    return {
      paypal: {
        vault_id: ps.vaultId,
        ...(ps.storedCredential ? { stored_credential: ps.storedCredential } : {}),
      },
    };
  }
  const paypal: Json = {};
  const ctx = experienceContext(ps.experienceContext ?? {}, hasShipTo);
  if (ctx) paypal.experience_context = ctx;
  if (ps.storeInVault || ps.customerId) {
    const attributes: Json = {};
    if (ps.customerId) attributes.customer = { id: ps.customerId };
    if (ps.storeInVault)
      attributes.vault = { store_in_vault: 'ON_SUCCESS', usage_type: 'MERCHANT', customer_type: 'CONSUMER' };
    paypal.attributes = attributes;
  }
  return { paypal };
}

/**
 * Builds the exact Orders v2 create body from integer-cent inputs. Pure: no I/O. The breakdown always sums:
 * amount = item_total + tax_total + shipping.
 */
export function buildOrderRequest(input: OrderInput): Json {
  if (input.intent !== 'CAPTURE' && input.intent !== 'AUTHORIZE')
    throw new PayPalValidationError('intent', 'must be CAPTURE or AUTHORIZE.');
  if (!input.items.length) throw new PayPalValidationError('items', 'at least one item is required.');
  const currency = input.items[0]!.unitAmount.currency;

  let itemTotal = 0;
  let itemTax = 0;
  let anyItemTax = false;
  const items = input.items.map((it, i) => {
    const f = `items[${i}]`;
    if (!it.name.trim()) throw new PayPalValidationError(`${f}.name`, 'is required.');
    if (!Number.isInteger(it.quantity) || it.quantity < 1)
      throw new PayPalValidationError(`${f}.quantity`, 'must be a whole number of at least 1.');
    checkMoney(it.unitAmount, currency, `${f}.unitAmount`);
    itemTotal += it.unitAmount.cents * it.quantity;
    if (it.tax) {
      checkMoney(it.tax, currency, `${f}.tax`);
      itemTax += it.tax.cents * it.quantity;
      anyItemTax = true;
    }
    return {
      name: it.name,
      quantity: String(it.quantity),
      unit_amount: amount(it.unitAmount),
      ...(it.tax ? { tax: amount(it.tax) } : {}),
      ...(it.sku ? { sku: it.sku } : {}),
      ...(it.description ? { description: it.description } : {}),
      ...(it.url ? { url: it.url } : {}),
      ...(paypalImageUrl(it.imageUrl) ? { image_url: paypalImageUrl(it.imageUrl) } : {}),
      category: it.category ?? 'PHYSICAL_GOODS',
    };
  });

  if (input.taxTotal) checkMoney(input.taxTotal, currency, 'taxTotal');
  if (anyItemTax && input.taxTotal && input.taxTotal.cents !== itemTax)
    throw new PayPalValidationError('taxTotal', 'differs from the sum of item tax x quantity.');
  const taxCents = anyItemTax ? itemTax : (input.taxTotal?.cents ?? 0);
  const hasTax = anyItemTax || input.taxTotal !== undefined;
  if (input.shipping) checkMoney(input.shipping, currency, 'shipping');
  const shippingCents = input.shipping?.cents ?? 0;
  const totalCents = itemTotal + taxCents + shippingCents;

  if (input.expectedTotal) {
    checkMoney(input.expectedTotal, currency, 'expectedTotal');
    if (input.expectedTotal.cents !== totalCents)
      throw new PayPalValidationError(
        'expectedTotal',
        `computed total ${toDecimalString({ cents: totalCents, currency })} differs from the confirmed ${toDecimalString(input.expectedTotal)}.`,
      );
  }

  const breakdown: Json = { item_total: amount({ cents: itemTotal, currency }) };
  if (input.shipping) breakdown.shipping = amount({ cents: shippingCents, currency });
  if (hasTax) breakdown.tax_total = amount({ cents: taxCents, currency });

  if (
    input.invoiceId !== undefined &&
    (input.invoiceId.length < 1 || input.invoiceId.length > INVOICE_ID_MAX_LENGTH)
  )
    throw new PayPalValidationError('invoiceId', `must be 1 to ${INVOICE_ID_MAX_LENGTH} characters.`);

  const unit: Json = {};
  if (input.referenceId) unit.reference_id = input.referenceId;
  if (input.description) unit.description = input.description;
  if (input.customId) unit.custom_id = input.customId.slice(0, CUSTOM_ID_MAX_LENGTH);
  if (input.invoiceId) unit.invoice_id = input.invoiceId;
  unit.amount = { ...amount({ cents: totalCents, currency }), breakdown };
  if (input.payeeMerchantId) unit.payee = { merchant_id: input.payeeMerchantId };
  unit.items = items;
  if (input.shipTo)
    unit.shipping = {
      type: 'SHIPPING',
      name: { full_name: input.shipTo.fullName },
      address: address(input.shipTo.address),
    };

  const body: Json = { intent: input.intent, purchase_units: [unit] };
  if (input.paymentSource) body.payment_source = paymentSource(input.paymentSource, Boolean(input.shipTo));
  return body;
}

// ---- Reading orders ----

/** Where to send the buyer to approve: `payer-action` (with payment_source) or `approve` (without). */
export function approvalUrl(order: Order): string | undefined {
  return (findLink(order, 'payer-action') ?? findLink(order, 'approve'))?.href;
}

export function captureFromOrder(order: Order): Capture | undefined {
  return order.purchase_units?.flatMap((u) => u.payments?.captures ?? [])[0];
}

export function authorizationFromOrder(order: Order): Authorization | undefined {
  return order.purchase_units?.flatMap((u) => u.payments?.authorizations ?? [])[0];
}

/** Vault token saved with this order (`payment_source.paypal.attributes.vault`), if any. */
export function vaultFromOrder(
  order: Order,
): { id?: string; status?: string; customerId?: string } | undefined {
  const v = order.payment_source?.paypal?.attributes?.vault;
  if (!v) return undefined;
  return { id: v.id, status: v.status, customerId: v.customer?.id };
}

// ---- API ----

export function ordersApi(http: HttpCore) {
  const base = '/v2/checkout/orders';
  return {
    async create(input: CreateOrderInput): Promise<Order> {
      const requestId = assertRequestId(input.requestId);
      const json = buildOrderRequest(input);
      const res = await http.request({
        method: 'POST',
        path: base,
        json,
        requestId,
        representation: true,
        headers: input.clientMetadataId ? { 'PayPal-Client-Metadata-Id': input.clientMetadataId } : undefined,
      });
      return parseWith(OrderSchema, res, base);
    },

    async get(orderId: string): Promise<Order> {
      const path = `${base}/${pathId(orderId, 'orderId')}`;
      return parseWith(OrderSchema, await http.request({ method: 'GET', path }), path);
    },

    /** Captures an approved CAPTURE-intent order (or a vault order created without immediate completion). */
    async capture(orderId: string, opts: { requestId: string; clientMetadataId?: string }): Promise<Order> {
      const path = `${base}/${pathId(orderId, 'orderId')}/capture`;
      const res = await http.request({
        method: 'POST',
        path,
        json: {},
        requestId: assertRequestId(opts.requestId),
        representation: true,
        headers: opts.clientMetadataId ? { 'PayPal-Client-Metadata-Id': opts.clientMetadataId } : undefined,
      });
      return parseWith(OrderSchema, res, path);
    },

    /** Authorizes an approved AUTHORIZE-intent order. Capture or void the authorization later via payments. */
    async authorize(orderId: string, opts: { requestId: string; clientMetadataId?: string }): Promise<Order> {
      const path = `${base}/${pathId(orderId, 'orderId')}/authorize`;
      const res = await http.request({
        method: 'POST',
        path,
        json: {},
        requestId: assertRequestId(opts.requestId),
        representation: true,
        headers: opts.clientMetadataId ? { 'PayPal-Client-Metadata-Id': opts.clientMetadataId } : undefined,
      });
      return parseWith(OrderSchema, res, path);
    },
  };
}

export type OrdersApi = ReturnType<typeof ordersApi>;
