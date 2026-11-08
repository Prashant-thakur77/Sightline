import { z } from 'zod';

/**
 * Response schemas for every PayPal body this package reads. All objects are loose: unknown fields
 * pass through untouched, and only the fields Sightline relies on are typed.
 */

export const LinkSchema = z.looseObject({ href: z.string(), rel: z.string(), method: z.string().optional() });
export type Link = z.infer<typeof LinkSchema>;
const Links = z.array(LinkSchema).optional();

export const MoneyFieldSchema = z.looseObject({ currency_code: z.string(), value: z.string() });
export type MoneyField = z.infer<typeof MoneyFieldSchema>;

export const TokenResponseSchema = z.looseObject({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
  token_type: z.string().optional(),
  app_id: z.string().optional(),
  scope: z.string().optional(),
  nonce: z.string().optional(),
  id_token: z.string().optional(),
});

// ---- Payments v2 ----

export const CaptureSchema = z.looseObject({
  id: z.string(),
  status: z.string().optional(),
  amount: MoneyFieldSchema.optional(),
  final_capture: z.boolean().optional(),
  invoice_id: z.string().optional(),
  custom_id: z.string().optional(),
  status_details: z.looseObject({ reason: z.string().optional() }).optional(),
  create_time: z.string().optional(),
  update_time: z.string().optional(),
  links: Links,
});
export type Capture = z.infer<typeof CaptureSchema>;

export const AuthorizationSchema = z.looseObject({
  id: z.string(),
  status: z.string().optional(),
  amount: MoneyFieldSchema.optional(),
  invoice_id: z.string().optional(),
  custom_id: z.string().optional(),
  expiration_time: z.string().optional(),
  create_time: z.string().optional(),
  update_time: z.string().optional(),
  links: Links,
});
export type Authorization = z.infer<typeof AuthorizationSchema>;

export const RefundSchema = z.looseObject({
  id: z.string(),
  status: z.string().optional(),
  amount: MoneyFieldSchema.optional(),
  invoice_id: z.string().optional(),
  note_to_payer: z.string().optional(),
  create_time: z.string().optional(),
  links: Links,
});
export type Refund = z.infer<typeof RefundSchema>;

// ---- Orders v2 ----

const VaultResponseSchema = z.looseObject({
  id: z.string().optional(),
  status: z.string().optional(),
  customer: z.looseObject({ id: z.string().optional() }).optional(),
  links: Links,
});

export const OrderTrackerSchema = z.looseObject({
  id: z.string(),
  status: z.string().optional(),
  links: Links,
});

export const PurchaseUnitSchema = z.looseObject({
  reference_id: z.string().optional(),
  custom_id: z.string().optional(),
  invoice_id: z.string().optional(),
  amount: MoneyFieldSchema.optional(),
  payments: z
    .looseObject({
      captures: z.array(CaptureSchema).optional(),
      authorizations: z.array(AuthorizationSchema).optional(),
      refunds: z.array(RefundSchema).optional(),
    })
    .optional(),
  shipping: z.looseObject({ trackers: z.array(OrderTrackerSchema).optional() }).optional(),
});

export const OrderSchema = z.looseObject({
  id: z.string(),
  status: z.string(),
  intent: z.string().optional(),
  purchase_units: z.array(PurchaseUnitSchema).optional(),
  payment_source: z
    .looseObject({
      paypal: z
        .looseObject({
          account_id: z.string().optional(),
          email_address: z.string().optional(),
          attributes: z.looseObject({ vault: VaultResponseSchema.optional() }).optional(),
        })
        .optional(),
    })
    .optional(),
  payer: z.looseObject({ payer_id: z.string().optional(), email_address: z.string().optional() }).optional(),
  links: Links,
});
export type Order = z.infer<typeof OrderSchema>;

// ---- Payment Method Tokens v3 ----

export const PaymentTokenSchema = z.looseObject({
  id: z.string(),
  customer: z
    .looseObject({ id: z.string().optional(), merchant_customer_id: z.string().optional() })
    .optional(),
  payment_source: z.record(z.string(), z.unknown()).optional(),
  links: Links,
});
export type PaymentToken = z.infer<typeof PaymentTokenSchema>;

export const PaymentTokenListSchema = z.looseObject({
  customer: z.looseObject({ id: z.string().optional() }).optional(),
  payment_tokens: z.array(PaymentTokenSchema).default([]),
  total_items: z.number().optional(),
  total_pages: z.number().optional(),
  links: Links,
});
export type PaymentTokenList = z.infer<typeof PaymentTokenListSchema>;

// ---- Shipment tracking ----

const ErrorItemSchema = z.looseObject({
  name: z.string().optional(),
  message: z.string().optional(),
  debug_id: z.string().optional(),
  details: z.array(z.looseObject({ field: z.string().optional(), issue: z.string().optional() })).optional(),
});

export const BatchTrackerResponseSchema = z.looseObject({
  tracker_identifiers: z
    .array(
      z.looseObject({ transaction_id: z.string(), tracking_number: z.string().optional(), links: Links }),
    )
    .default([]),
  errors: z.array(ErrorItemSchema).default([]),
  links: Links,
});
export type BatchTrackerResponse = z.infer<typeof BatchTrackerResponseSchema>;

export const TrackerCollectionSchema = z.looseObject({
  trackers: z
    .array(
      z.looseObject({
        transaction_id: z.string(),
        tracking_number: z.string().optional(),
        status: z.string().optional(),
        carrier: z.string().optional(),
        links: Links,
      }),
    )
    .default([]),
  links: Links,
});
export type TrackerCollection = z.infer<typeof TrackerCollectionSchema>;

// ---- Disputes v1 ----

export const DisputedTransactionSchema = z.looseObject({
  buyer_transaction_id: z.string().optional(),
  seller_transaction_id: z.string().optional(),
  invoice_number: z.string().optional(),
  custom: z.string().optional(),
  gross_amount: MoneyFieldSchema.optional(),
  seller: z.looseObject({ merchant_id: z.string().optional() }).optional(),
});

export const EvidenceSchema = z.looseObject({
  evidence_type: z.string().optional(),
  source: z.string().optional(),
  notes: z.string().optional(),
  date: z.string().optional(),
});

export const DisputeSchema = z.looseObject({
  dispute_id: z.string(),
  create_time: z.string().optional(),
  update_time: z.string().optional(),
  reason: z.string().optional(),
  status: z.string().optional(),
  dispute_state: z.string().optional(),
  dispute_life_cycle_stage: z.string().optional(),
  dispute_channel: z.string().optional(),
  dispute_amount: MoneyFieldSchema.optional(),
  disputed_transactions: z.array(DisputedTransactionSchema).optional(),
  evidences: z.array(EvidenceSchema).optional(),
  messages: z
    .array(
      z.looseObject({
        posted_by: z.string().optional(),
        content: z.string().optional(),
        time_posted: z.string().optional(),
      }),
    )
    .optional(),
  offer: z
    .looseObject({
      buyer_requested_amount: MoneyFieldSchema.optional(),
      seller_offered_amount: MoneyFieldSchema.optional(),
      offer_type: z.string().optional(),
    })
    .optional(),
  dispute_outcome: z
    .looseObject({ outcome_code: z.string().optional(), amount_refunded: MoneyFieldSchema.optional() })
    .optional(),
  allowed_response_options: z
    .looseObject({
      make_offer: z.looseObject({ offer_types: z.array(z.string()).optional() }).optional(),
      accept_claim: z.looseObject({ accept_claim_types: z.array(z.string()).optional() }).optional(),
      acknowledge_return_item: z
        .looseObject({ acknowledgement_types: z.array(z.string()).optional() })
        .optional(),
    })
    .optional(),
  seller_response_due_date: z.string().optional(),
  buyer_response_due_date: z.string().optional(),
  links: Links,
});
export type Dispute = z.infer<typeof DisputeSchema>;

export const DisputeListSchema = z.looseObject({
  items: z.array(DisputeSchema).default([]),
  links: Links,
});
export type DisputeList = z.infer<typeof DisputeListSchema>;

/** Body of every dispute action: just HATEOAS links back to the dispute. */
export const SubsequentActionSchema = z.looseObject({ links: Links });
export type SubsequentAction = z.infer<typeof SubsequentActionSchema>;

// ---- Webhooks ----

export const WebhookSchema = z.looseObject({
  id: z.string(),
  url: z.string(),
  event_types: z.array(z.looseObject({ name: z.string(), status: z.string().optional() })).default([]),
  links: Links,
});
export type Webhook = z.infer<typeof WebhookSchema>;

export const WebhookListSchema = z.looseObject({ webhooks: z.array(WebhookSchema).default([]) });

export const EventTypeListSchema = z.looseObject({
  event_types: z
    .array(
      z.looseObject({
        name: z.string(),
        description: z.string().optional(),
        status: z.string().optional(),
        resource_versions: z.array(z.string()).optional(),
      }),
    )
    .default([]),
});
export type EventTypeList = z.infer<typeof EventTypeListSchema>;

export const VerifySignatureResponseSchema = z.looseObject({ verification_status: z.string() });

export const WebhookEventSchema = z.looseObject({
  id: z.string().min(1),
  event_type: z.string().min(1),
  create_time: z.string().optional(),
  resource_type: z.string().optional(),
  resource_version: z.string().optional(),
  event_version: z.string().optional(),
  summary: z.string().optional(),
  resource: z.record(z.string(), z.unknown()),
  links: Links,
});
export type WebhookEvent = z.infer<typeof WebhookEventSchema>;

// ---- Transaction Search ----

export const TransactionDetailSchema = z.looseObject({
  transaction_info: z.looseObject({
    transaction_id: z.string().optional(),
    paypal_account_id: z.string().optional(),
    paypal_reference_id: z.string().optional(),
    paypal_reference_id_type: z.string().optional(),
    transaction_event_code: z.string().optional(),
    transaction_initiation_date: z.string().optional(),
    transaction_updated_date: z.string().optional(),
    transaction_amount: MoneyFieldSchema.optional(),
    transaction_status: z.string().optional(),
    invoice_id: z.string().optional(),
    custom_field: z.string().optional(),
  }),
  payer_info: z
    .looseObject({ account_id: z.string().optional(), email_address: z.string().optional() })
    .optional(),
});

export const TransactionSearchSchema = z.looseObject({
  transaction_details: z.array(TransactionDetailSchema).default([]),
  account_number: z.string().optional(),
  start_date: z.string().optional(),
  end_date: z.string().optional(),
  page: z.number().optional(),
  total_items: z.number().optional(),
  total_pages: z.number().optional(),
  links: Links,
});
export type TransactionSearch = z.infer<typeof TransactionSearchSchema>;
