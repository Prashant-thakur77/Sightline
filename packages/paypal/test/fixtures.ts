/**
 * Response bodies shaped after the example responses in PayPal's live API reference and guides
 * (Orders v2, Payments v2, Payment Method Tokens v3, Add Tracking, Disputes v1, Webhooks, Transaction Search).
 */

const SB = 'https://api-m.sandbox.paypal.com';

export const orderCreated = {
  id: '5O190127TN364715T',
  status: 'PAYER_ACTION_REQUIRED',
  payment_source: { paypal: {} },
  links: [
    { href: `${SB}/v2/checkout/orders/5O190127TN364715T`, rel: 'self', method: 'GET' },
    {
      href: 'https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T',
      rel: 'payer-action',
      method: 'GET',
    },
  ],
};

export const orderCreatedNoSource = {
  id: '5O190127TN364715T',
  status: 'CREATED',
  links: [
    { href: 'https://api-m.paypal.com/v2/checkout/orders/5O190127TN364715T', rel: 'self', method: 'GET' },
    { href: 'https://www.paypal.com/checkoutnow?token=5O190127TN364715T', rel: 'approve', method: 'GET' },
    { href: 'https://api-m.paypal.com/v2/checkout/orders/5O190127TN364715T', rel: 'edit', method: 'PATCH' },
    {
      href: 'https://api-m.paypal.com/v2/checkout/orders/5O190127TN364715T/capture',
      rel: 'capture',
      method: 'POST',
    },
  ],
};

export const orderCapturedWithVault = {
  id: '5O190127TN364715T',
  status: 'COMPLETED',
  payment_source: {
    paypal: { attributes: { vault: { id: 'nkq2y9g', status: 'VAULTED', customer: { id: 'ROaPMoZUaV' } } } },
  },
  purchase_units: [
    {
      reference_id: 'default',
      payments: {
        captures: [
          {
            id: '8MC585209K746392H',
            status: 'COMPLETED',
            amount: { currency_code: 'USD', value: '230.00' },
            final_capture: true,
            seller_protection: {
              status: 'ELIGIBLE',
              dispute_categories: ['ITEM_NOT_RECEIVED', 'UNAUTHORIZED_TRANSACTION'],
            },
            links: [
              { href: `${SB}/v2/payments/captures/8MC585209K746392H`, rel: 'self', method: 'GET' },
              { href: `${SB}/v2/payments/captures/8MC585209K746392H/refund`, rel: 'refund', method: 'POST' },
            ],
            create_time: '2022-09-27T20:52:27Z',
            update_time: '2022-09-27T20:52:27Z',
          },
        ],
      },
    },
  ],
  payer: { email_address: 'payer@example.com', payer_id: '4VUS3C84RXJDA' },
  links: [{ href: `${SB}/v2/checkout/orders/5O190127TN364715T`, rel: 'self', method: 'GET' }],
};

export const orderAuthorized = {
  id: '5O190127TN364715T',
  status: 'COMPLETED',
  payment_source: { paypal: { email_address: 'customer@example.com', account_id: 'QYR5Z8XDVJNXQ' } },
  purchase_units: [
    {
      reference_id: 'd9f80740-38f0-11e8-b467-0ed5f89f718b',
      payments: {
        authorizations: [
          {
            id: '3C679366HH908993F',
            status: 'CREATED',
            amount: { currency_code: 'USD', value: '100.00' },
            seller_protection: {
              status: 'ELIGIBLE',
              dispute_categories: ['ITEM_NOT_RECEIVED', 'UNAUTHORIZED_TRANSACTION'],
            },
            expiration_time: '2021-10-08T23:37:39Z',
            links: [
              {
                href: 'https://api-m.paypal.com/v2/payments/authorizations/3C679366HH908993F',
                rel: 'self',
                method: 'GET',
              },
              {
                href: 'https://api-m.paypal.com/v2/payments/authorizations/3C679366HH908993F/capture',
                rel: 'capture',
                method: 'POST',
              },
              {
                href: 'https://api-m.paypal.com/v2/payments/authorizations/3C679366HH908993F/void',
                rel: 'void',
                method: 'POST',
              },
            ],
          },
        ],
      },
    },
  ],
  payer: { email_address: 'customer@example.com', payer_id: 'QYR5Z8XDVJNXQ' },
  links: [
    { href: 'https://api-m.paypal.com/v2/checkout/orders/5O190127TN364715T', rel: 'self', method: 'GET' },
  ],
};

export const authorizationCaptured = {
  id: '2GG279541U471931P',
  status: 'COMPLETED',
  status_details: {},
  amount: { value: '10.99', currency_code: 'USD' },
  final_capture: true,
  seller_protection: {
    status: 'ELIGIBLE',
    dispute_categories: ['ITEM_NOT_RECEIVED', 'UNAUTHORIZED_TRANSACTION'],
  },
  seller_receivable_breakdown: {
    gross_amount: { value: '10.99', currency_code: 'USD' },
    paypal_fee: { value: '0.33', currency_code: 'USD' },
    net_amount: { value: '10.66', currency_code: 'USD' },
  },
  invoice_id: 'INV-123',
  create_time: '2017-09-11T23:24:01Z',
  update_time: '2017-09-11T23:24:01Z',
  links: [
    { rel: 'self', method: 'GET', href: 'https://api-m.paypal.com/v2/payments/captures/2GG279541U471931P' },
    {
      rel: 'refund',
      method: 'POST',
      href: 'https://api-m.paypal.com/v2/payments/captures/2GG279541U471931P/refund',
    },
    {
      rel: 'up',
      method: 'GET',
      href: 'https://api-m.paypal.com/v2/payments/authorizations/0VF52814937998046',
    },
  ],
};

export const authorizationVoided = {
  id: '3C679366HH908993F',
  status: 'VOIDED',
  amount: { currency_code: 'USD', value: '100.00' },
  invoice_id: 'OrderInvoice-10_10_2024_12_06_00_pm',
  expiration_time: '2024-11-08T09:06:03-08:00',
  create_time: '2024-10-10T10:06:03-07:00',
  update_time: '2024-10-10T10:06:19-07:00',
  links: [
    {
      href: 'https://api.paypal.com/v2/payments/authorizations/3C679366HH908993F',
      rel: 'self',
      method: 'GET',
    },
  ],
};

export const reauthorized = {
  id: '8AA831015G517922L',
  status: 'CREATED',
  amount: { value: '10.99', currency_code: 'USD' },
  expiration_time: '2018-10-10T23:23:45Z',
  links: [
    {
      rel: 'self',
      method: 'GET',
      href: 'https://api-m.paypal.com/v2/payments/authorizations/8AA831015G517922L',
    },
    {
      rel: 'capture',
      method: 'POST',
      href: 'https://api-m.paypal.com/v2/payments/authorizations/8AA831015G517922L/capture',
    },
  ],
};

export const refunded = {
  id: '1JU08902781691411',
  amount: { value: '10.99', currency_code: 'USD' },
  status: 'COMPLETED',
  note: 'Defective product',
  invoice_id: 'INVOICE-123',
  create_time: '2018-09-11T23:24:19Z',
  update_time: '2018-09-11T23:24:19Z',
  links: [
    { rel: 'self', method: 'GET', href: 'https://api-m.paypal.com/v2/payments/refunds/1JU08902781691411' },
    { rel: 'up', method: 'GET', href: 'https://api-m.paypal.com/v2/payments/captures/2GG279541U471931P' },
  ],
};

export const paymentTokens = {
  customer: { id: 'ROaPMoZUaV' },
  payment_tokens: [
    {
      id: 'nkq2y9g',
      customer: { id: 'ROaPMoZUaV' },
      payment_source: { paypal: { email_address: 'payer@example.com', account_id: '4VUS3C84RXJDA' } },
      links: [{ rel: 'self', href: `${SB}/v3/vault/payment-tokens/nkq2y9g`, method: 'GET' }],
    },
  ],
  links: [],
};

export const orderTracked = {
  id: '5O190127TN364715T',
  status: 'COMPLETED',
  purchase_units: [
    {
      reference_id: 'd9f80740-38f0-11e8-b467-0ed5f89f718b',
      items: [{ name: 'T-Shirt', sku: 'sku01', quantity: '1' }],
      shipping: {
        trackers: [
          {
            id: '8MC585209K746392H-443844607820',
            links: [
              {
                href: 'https://api-m.paypal.com/v2/checkout/orders/5O190127TN364715T',
                rel: 'up',
                method: 'GET',
              },
              {
                href: 'https://api-m.paypal.com/v2/checkout/orders/5O190127TN364715T/trackers/8MC585209K746392H-443844607820',
                rel: 'update',
                method: 'PATCH',
              },
            ],
            create_time: '2022-08-12T21:20:49Z',
            update_time: '2022-08-12T21:20:49Z',
          },
        ],
      },
      payments: {
        captures: [
          { id: '8MC585209K746392H', status: 'COMPLETED', amount: { currency_code: 'USD', value: '100.00' } },
        ],
      },
    },
  ],
  links: [
    { href: 'https://api-m.paypal.com/v2/checkout/orders/5O190127TN364715T', rel: 'self', method: 'GET' },
  ],
};

export const trackersBatchOk = {
  tracker_identifiers: [
    {
      transaction_id: '8MC585209K746392H',
      tracking_number: '443844607820',
      links: [
        { href: `${SB}/v1/shipping/trackers/8MC585209K746392H-443844607820`, rel: 'self', method: 'GET' },
        { href: `${SB}/v1/shipping/trackers/8MC585209K746392H-443844607820`, rel: 'replace', method: 'PUT' },
      ],
    },
  ],
  errors: [],
  links: [{ href: `${SB}/v1/shipping/trackers-batch`, rel: 'self', method: 'POST' }],
};

export const trackersBatchPartialError = {
  tracker_identifiers: [],
  errors: [
    {
      name: 'RESOURCE_NOT_FOUND',
      debug_id: '46735c7461f3d',
      message: 'The specified resource does not exist.',
      details: [
        {
          field: '/trackers/0/transaction_id',
          value: '8MC585309K746392H',
          location: 'body',
          issue: 'INVALID_TRANSACTION_ID',
        },
      ],
    },
  ],
  links: [{ href: `${SB}/v1/shipping/trackers-batch`, rel: 'self', method: 'POST' }],
};

const D = 'PP-R-AYP-10135034';
const DL = `${SB}/v1/customer/disputes/${D}`;

/** Show-dispute-details example from the live Disputes guide (INQUIRY, waiting for the seller). */
export const disputeInquiry = {
  dispute_id: D,
  create_time: '2025-09-18T09:46:54.926Z',
  update_time: '2025-09-18T09:49:53.336Z',
  disputed_transactions: [
    {
      buyer_transaction_id: '7XB07472F52871902',
      seller_transaction_id: '8AW70038VH226914P',
      transaction_status: 'HELD',
      gross_amount: { currency_code: 'USD', value: '2.00' },
      seller: {
        email: 'sb-ekqdo43289257@business.example.com',
        merchant_id: 'HAAP3SNYZZ9NG',
        name: 'The Happy Store',
      },
    },
  ],
  reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
  status: 'WAITING_FOR_SELLER_RESPONSE',
  dispute_amount: { currency_code: 'USD', value: '2.00' },
  dispute_state: 'REQUIRED_ACTION',
  dispute_life_cycle_stage: 'INQUIRY',
  dispute_channel: 'INTERNAL',
  evidences: [
    {
      evidence_type: 'CREATE',
      notes: 'Test support case',
      source: 'SUBMITTED_BY_BUYER',
      date: '2025-09-18T09:46:54.926Z',
    },
    {
      evidence_type: 'PROOF_OF_FULFILLMENT',
      source: 'REQUESTED_FROM_SELLER',
      date: '2025-09-18T09:49:53.336Z',
    },
  ],
  seller_response_due_date: '2025-10-08T09:46:54.926Z',
  offer: { buyer_requested_amount: { currency_code: 'USD', value: '2.00' } },
  allowed_response_options: {
    accept_claim: { accept_claim_types: ['PARTIAL_REFUND', 'REFUND'] },
    make_offer: { offer_types: ['REFUND'] },
  },
  links: [
    { href: DL, rel: 'self', method: 'GET' },
    { href: `${DL}/send-message`, rel: 'send_message', method: 'POST' },
    { href: `${DL}/escalate`, rel: 'escalate', method: 'POST' },
    { href: `${DL}/accept-claim`, rel: 'accept_claim', method: 'POST' },
    { href: `${DL}/make-offer`, rel: 'make_offer', method: 'POST' },
    { href: `${DL}/provide-evidence`, rel: 'provide_evidence', method: 'POST' },
  ],
};

/** Same dispute after it went to PayPal review: only self + sandbox simulation links. */
export const disputeUnderReview = {
  ...disputeInquiry,
  status: 'UNDER_REVIEW',
  dispute_state: 'UNDER_PAYPAL_REVIEW',
  dispute_life_cycle_stage: 'CHARGEBACK',
  allowed_response_options: undefined,
  links: [
    { href: DL, rel: 'self', method: 'GET' },
    { href: `${DL}/adjudicate`, rel: 'adjudicate', method: 'POST' },
    { href: `${DL}/require-evidence`, rel: 'require_evidence', method: 'POST' },
  ],
};

/** Resolved: no actions at all. */
export const disputeResolved = {
  ...disputeInquiry,
  status: 'RESOLVED',
  dispute_state: 'RESOLVED',
  allowed_response_options: undefined,
  links: [{ href: DL, rel: 'self', method: 'GET' }],
};

/** Buyer view with a merchant offer on the table. */
export const disputeOfferForBuyer = {
  ...disputeInquiry,
  status: 'WAITING_FOR_BUYER_RESPONSE',
  offer: { seller_offered_amount: { currency_code: 'USD', value: '2.00' }, offer_type: 'REFUND' },
  allowed_response_options: undefined,
  links: [
    { href: DL, rel: 'self', method: 'GET' },
    { href: `${DL}/accept-offer`, rel: 'accept_offer', method: 'POST' },
    { href: `${DL}/deny-offer`, rel: 'deny_offer', method: 'POST' },
    { href: `${DL}/send-message`, rel: 'send_message', method: 'POST' },
  ],
};

export const disputeList = {
  items: [
    {
      dispute_id: 'PP-R-ORC-10135512',
      create_time: '2025-09-23T09:25:28.000Z',
      update_time: '2025-09-23T09:47:03.000Z',
      disputed_transactions: [
        { buyer_transaction_id: '1XC473123G8516345', seller: { merchant_id: 'HAAP3SNYZZ9NG' } },
      ],
      reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED',
      status: 'RESOLVED',
      dispute_state: 'RESOLVED',
      dispute_amount: { currency_code: 'USD', value: '10.00' },
      dispute_life_cycle_stage: 'INQUIRY',
      dispute_channel: 'INTERNAL',
      outcome: 'LOST',
      links: [{ href: `${SB}/v1/customer/disputes/PP-R-ORC-10135512`, rel: 'self', method: 'GET' }],
    },
  ],
  links: [
    { href: `${SB}/v1/customer/disputes`, rel: 'self', method: 'GET' },
    { href: `${SB}/v1/customer/disputes`, rel: 'first', method: 'GET' },
  ],
};

export const subsequentAction = { links: [{ href: DL, rel: 'detail', method: 'GET' }] };

export const disputeCreated = {
  links: [{ href: `${SB}/v1/customer/disputes/PP-D-27803`, rel: 'self', method: 'GET' }],
};

export const webhookCreated = {
  id: '0EH40505U7160970P',
  url: 'https://sightline.example.com/api/webhooks/paypal',
  event_types: [
    { name: 'PAYMENT.CAPTURE.COMPLETED', description: 'A payment capture completes.' },
    { name: 'CUSTOMER.DISPUTE.CREATED', description: 'A dispute is created.' },
  ],
  links: [{ href: `${SB}/v1/notifications/webhooks/0EH40505U7160970P`, rel: 'self', method: 'GET' }],
};

export const eventTypes = {
  event_types: [
    {
      name: 'CHECKOUT.ORDER.APPROVED',
      description: 'A buyer approved a checkout order',
      status: 'ENABLED',
      resource_versions: ['2.0'],
    },
    {
      name: 'PAYMENT.CAPTURE.COMPLETED',
      description: 'A payment capture completes.',
      status: 'ENABLED',
      resource_versions: ['2.0'],
    },
    {
      name: 'CUSTOMER.DISPUTE.CREATED',
      description: 'A dispute is created.',
      status: 'ENABLED',
      resource_versions: ['1.0'],
    },
  ],
};

/** A capture-completed delivery, kept as the exact string PayPal would send (spacing included). */
export const rawCaptureEvent =
  '{"id":"WH-58D329510W468432D-8HN650336L201105X","event_version":"1.0","create_time":"2026-11-09T21:50:07.940Z",' +
  '"resource_type":"capture","resource_version":"2.0","event_type":"PAYMENT.CAPTURE.COMPLETED",' +
  '"summary":"Payment completed for $ 36.72 USD",  "resource":{"id":"8MC585209K746392H","status":"COMPLETED",' +
  '"amount":{"currency_code":"USD","value":"36.72"},"final_capture":true,"custom_id":"rb_9f2c",' +
  '"links":[{"href":"https://api-m.sandbox.paypal.com/v2/payments/captures/8MC585209K746392H","rel":"self","method":"GET"}]},' +
  '"links":[{"href":"https://api-m.sandbox.paypal.com/v1/notifications/webhooks-events/WH-58D329510W468432D-8HN650336L201105X","rel":"self","method":"GET"}]}';

export const transactionSearch = {
  transaction_details: [
    {
      transaction_info: {
        paypal_account_id: '6STWC2LSUYYYE',
        transaction_id: '5TY05013RG002845M',
        transaction_event_code: 'T0006',
        transaction_initiation_date: '2026-11-01T23:46:46+0000',
        transaction_updated_date: '2026-11-01T23:46:46+0000',
        transaction_amount: { currency_code: 'USD', value: '36.72' },
        transaction_status: 'S',
        invoice_id: 'ord_123',
        custom_field: 'rb_9f2c',
      },
      payer_info: { account_id: '6STWC2LSUYYYE', email_address: 'buyer@personal.example.com' },
    },
  ],
  account_number: 'XZXSPECPDZHZU',
  start_date: '2026-10-15T00:00:00+0000',
  end_date: '2026-11-09T00:00:00+0000',
  page: 1,
  total_items: 1,
  total_pages: 1,
  links: [],
};
