import { describe, expect, it } from 'vitest';
import {
  PayPalActionUnavailableError,
  PayPalValidationError,
  buildAuthAssertion,
  buildCreateDisputeInput,
  findLink,
  hasAction,
  idFromSelfLink,
  validateEvidenceFiles,
  type Dispute,
} from '../src';
import {
  disputeCreated,
  disputeInquiry,
  disputeList,
  disputeOfferForBuyer,
  disputeResolved,
  disputeUnderReview,
  subsequentAction,
} from './fixtures';
import { JPEG, PDF, PNG, jsonOf, mockPayPal, parseMultipart, testClient, usd } from './helpers';

const ID = 'PP-R-AYP-10135034';
const P = `/v1/customer/disputes/${ID}`;
const inquiry = disputeInquiry as unknown as Dispute;
const resolved = disputeResolved as unknown as Dispute;
const underReview = disputeUnderReview as unknown as Dispute;

describe('HATEOAS helpers', () => {
  it('matches rels across "_" and "-" spellings and by action path', () => {
    expect(findLink(inquiry, 'make-offer')?.href).toMatch(/make-offer$/);
    expect(hasAction(inquiry, 'provide_evidence')).toBe(true);
    expect(hasAction(inquiry, 'appeal')).toBe(false);
    expect(
      hasAction(
        {
          links: [
            { href: `https://x/v1/customer/disputes/${ID}/accept-offer`, rel: 'detail', method: 'POST' },
          ],
        },
        'accept_offer',
      ),
    ).toBe(true);
    expect(
      hasAction(
        {
          links: [
            { href: `https://x/v1/customer/disputes/${ID}/accept-offer`, rel: 'detail', method: 'GET' },
          ],
        },
        'accept_offer',
      ),
    ).toBe(false);
    expect(idFromSelfLink(disputeCreated)).toBe('PP-D-27803');
  });
});

describe('merchant disputes: gating', () => {
  it('throws a typed error before any request when the action link is absent', async () => {
    const mock = mockPayPal();
    const { client } = testClient(mock);
    const calls: Promise<unknown>[] = [
      client.disputes.makeOffer(resolved, {
        requestId: 'o1',
        offerType: 'REFUND',
        note: 'Sorry',
        offerAmount: usd(200),
      }),
      client.disputes.acceptClaim(resolved, { requestId: 'a1', note: 'Refunding' }),
      client.disputes.provideEvidence(resolved, { evidences: [{ evidence_type: 'OTHER', notes: 'x' }] }),
      client.disputes.sendMessage(resolved, { message: 'hi' }),
      client.disputes.escalate(resolved, { note: 'x' }),
      client.disputes.appeal(resolved, { evidences: [{ evidence_type: 'OTHER', notes: 'x' }] }),
      client.disputes.acknowledgeReturnItem(resolved, { acknowledgementType: 'ITEM_RECEIVED' }),
      client.disputes.provideSupportingInfo(resolved, { notes: 'x' }),
    ];
    for (const p of calls) await expect(p).rejects.toBeInstanceOf(PayPalActionUnavailableError);
    expect(mock.calls).toHaveLength(0);
  });

  it('rejects an offer type the dispute does not allow, before sending', async () => {
    const mock = mockPayPal();
    const err = await testClient(mock)
      .client.disputes.makeOffer(inquiry, {
        requestId: 'o2',
        offerType: 'REFUND_WITH_REPLACEMENT',
        note: 'We will replace it',
        offerAmount: usd(200),
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(PayPalActionUnavailableError);
    expect(err.available).toEqual(['REFUND']);
    expect(mock.calls).toHaveLength(0);
  });

  it('fetches the dispute first when given only an id, then gates on fresh links', async () => {
    const mock = mockPayPal().on('GET', P, { status: 200, json: disputeResolved });
    const err = await testClient(mock)
      .client.disputes.escalate(ID, { note: 'Escalating' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(PayPalActionUnavailableError);
    expect(mock.api().map((c) => `${c.method} ${c.path}`)).toEqual([`GET ${P}`]);
  });
});

describe('merchant disputes: actions', () => {
  it('makes an offer with the request id and exact body', async () => {
    const mock = mockPayPal().on('POST', `${P}/make-offer`, { status: 200, json: subsequentAction });
    await testClient(mock).client.disputes.makeOffer(inquiry, {
      requestId: 'sl-offer-1',
      offerType: 'REFUND',
      note: 'Refund offered for the wrong colour.',
      offerAmount: usd(200),
      invoiceId: 'ord_01JC8Z',
    });
    const call = mock.api()[0]!;
    expect(call.headers['paypal-request-id']).toBe('sl-offer-1');
    expect(call.headers['content-type']).toBe('application/json');
    expect(jsonOf(call)).toEqual({
      note: 'Refund offered for the wrong colour.',
      offer_type: 'REFUND',
      offer_amount: { currency_code: 'USD', value: '2.00' },
      invoice_id: 'ord_01JC8Z',
    });
  });

  it('validates offers: amount and return address where PayPal needs them, request id always', async () => {
    const { client } = testClient(mockPayPal());
    await expect(
      client.disputes.makeOffer(inquiry, { requestId: 'o', offerType: 'REFUND', note: 'x' }),
    ).rejects.toThrow(/offerAmount/);
    await expect(
      client.disputes.makeOffer(inquiry, {
        requestId: 'o',
        offerType: 'REFUND_WITH_RETURN',
        note: 'x',
        offerAmount: usd(200),
      }),
    ).rejects.toThrow(/returnShippingAddress/);
    await expect(
      client.disputes.makeOffer(inquiry, {
        requestId: '',
        offerType: 'REFUND',
        note: 'x',
        offerAmount: usd(1),
      }),
    ).rejects.toBeInstanceOf(PayPalValidationError);
  });

  it('accepts a claim only with a request id and an allowed claim type', async () => {
    const mock = mockPayPal().on('POST', `${P}/accept-claim`, { status: 200, json: subsequentAction });
    const { client } = testClient(mock);
    await expect(client.disputes.acceptClaim(inquiry, { requestId: '', note: 'x' })).rejects.toBeInstanceOf(
      PayPalValidationError,
    );
    await expect(
      client.disputes.acceptClaim(inquiry, {
        requestId: 'c1',
        note: 'x',
        acceptClaimType: 'REFUND_WITH_RETURN',
      }),
    ).rejects.toBeInstanceOf(PayPalActionUnavailableError);
    await client.disputes.acceptClaim(inquiry, {
      requestId: 'sl-claim-1',
      note: 'Full refund to the customer.',
      acceptClaimType: 'REFUND',
    });
    expect(mock.api()).toHaveLength(1);
    expect(mock.api()[0]!.headers['paypal-request-id']).toBe('sl-claim-1');
    expect(jsonOf(mock.api()[0]!)).toEqual({
      note: 'Full refund to the customer.',
      accept_claim_type: 'REFUND',
    });
  });

  it('provides evidence as multipart: an input JSON part plus file parts, byte-exact', async () => {
    const mock = mockPayPal().on('POST', `${P}/provide-evidence`, { status: 200, json: subsequentAction });
    const evidences = [
      {
        evidence_type: 'PROOF_OF_FULFILLMENT',
        evidence_info: { tracking_info: [{ carrier_name: 'FEDEX', tracking_number: '122533485' }] },
        notes: 'Delivered 9 Nov.',
      },
    ];
    await testClient(mock).client.disputes.provideEvidence(inquiry, {
      evidences,
      files: [
        { filename: 'delivery photo.png', contentType: 'image/png', data: PNG },
        { filename: 'receipt.pdf', contentType: 'application/pdf', data: PDF },
      ],
    });
    const call = mock.api()[0]!;
    const ct = call.headers['content-type']!;
    expect(ct).toMatch(/^multipart\/form-data; boundary=----paypal-form-[0-9a-f]{32}$/);
    expect(call.rawBody).toBeInstanceOf(Uint8Array);
    const parts = parseMultipart(call.rawBody as Uint8Array, ct);
    expect(parts.map((p) => [p.name, p.filename, p.contentType])).toEqual([
      ['input', undefined, 'application/json'],
      ['file1', 'delivery photo.png', 'image/png'],
      ['file2', 'receipt.pdf', 'application/pdf'],
    ]);
    expect(JSON.parse(parts[0]!.text)).toEqual({ evidences });
    expect(Array.from(parts[1]!.bytes)).toEqual(Array.from(PNG));
    expect(Array.from(parts[2]!.bytes)).toEqual(Array.from(PDF));
  });

  it('sends provide-evidence as multipart even without files', async () => {
    const mock = mockPayPal().on('POST', `${P}/provide-evidence`, { status: 200, json: subsequentAction });
    await testClient(mock).client.disputes.provideEvidence(inquiry, {
      evidences: [{ evidence_type: 'PROOF_OF_REFUND', evidence_info: { refund_ids: ['1JU08902781691411'] } }],
    });
    const call = mock.api()[0]!;
    const parts = parseMultipart(call.rawBody as Uint8Array, call.headers['content-type']!);
    expect(parts).toHaveLength(1);
    expect(JSON.parse(parts[0]!.text).evidences[0].evidence_info.refund_ids).toEqual(['1JU08902781691411']);
  });

  it('sends a message as JSON, or multipart when a file is attached', async () => {
    const mock = mockPayPal().on('POST', `${P}/send-message`, { status: 200, json: subsequentAction });
    const { client } = testClient(mock);
    await client.disputes.sendMessage(inquiry, { message: 'Shipment is in progress.' });
    await client.disputes.sendMessage(inquiry, {
      message: 'Photo attached.',
      files: [{ filename: 'item.jpg', contentType: 'image/jpeg', data: JPEG }],
    });
    const [a, b] = mock.api();
    expect(jsonOf(a!)).toEqual({ message: 'Shipment is in progress.' });
    const parts = parseMultipart(b!.rawBody as Uint8Array, b!.headers['content-type']!);
    expect(JSON.parse(parts[0]!.text)).toEqual({ message: 'Photo attached.' });
    expect(parts[1]!.filename).toBe('item.jpg');
  });

  it('validates evidence files before any request', async () => {
    const mock = mockPayPal();
    const err = await testClient(mock)
      .client.disputes.provideEvidence(inquiry, {
        evidences: [{ evidence_type: 'OTHER', notes: 'x' }],
        files: [{ filename: 'clip.mp4', contentType: 'video/mp4', data: PNG }],
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(PayPalValidationError);
    expect(mock.calls).toHaveLength(0);
  });

  it('lists with filters, joining several states with commas', async () => {
    const mock = mockPayPal().on('GET', '/v1/customer/disputes', { status: 200, json: disputeList });
    const list = await testClient(mock).client.disputes.list({
      disputeState: ['REQUIRED_ACTION', 'UNDER_PAYPAL_REVIEW'],
      disputedTransactionId: '8AW70038VH226914P',
      pageSize: 20,
      updateTimeAfter: '2026-11-01T00:00:00.000Z',
    });
    expect(list.items[0]!.dispute_id).toBe('PP-R-ORC-10135512');
    const q = mock.api()[0]!.query;
    expect(q.get('dispute_state')).toBe('REQUIRED_ACTION,UNDER_PAYPAL_REVIEW');
    expect(q.get('disputed_transaction_id')).toBe('8AW70038VH226914P');
    expect(q.get('page_size')).toBe('20');
    expect(q.get('update_time_after')).toBe('2026-11-01T00:00:00.000Z');
    await expect(testClient(mock).client.disputes.list({ pageSize: 51 })).rejects.toBeInstanceOf(
      PayPalValidationError,
    );
  });

  it('acknowledges a returned item with an allowed type', async () => {
    const withAck = {
      ...inquiry,
      allowed_response_options: {
        acknowledge_return_item: { acknowledgement_types: ['ITEM_RECEIVED', 'DAMAGED'] },
      },
      links: [
        ...inquiry.links!,
        { href: `https://x${P}/acknowledge-return-item`, rel: 'acknowledge_return_item', method: 'POST' },
      ],
    } as Dispute;
    const mock = mockPayPal().on('POST', `${P}/acknowledge-return-item`, {
      status: 200,
      json: subsequentAction,
    });
    const { client } = testClient(mock);
    await expect(
      client.disputes.acknowledgeReturnItem(withAck, { acknowledgementType: 'MISSING_ITEMS' }),
    ).rejects.toBeInstanceOf(PayPalActionUnavailableError);
    await client.disputes.acknowledgeReturnItem(withAck, {
      note: 'I have received the item back.',
      acknowledgementType: 'ITEM_RECEIVED',
    });
    expect(jsonOf(mock.api()[0]!)).toEqual({
      note: 'I have received the item back.',
      acknowledgement_type: 'ITEM_RECEIVED',
    });
  });
});

describe('sandbox simulation', () => {
  it('adjudicates only when UNDER_REVIEW with the adjudicate link', async () => {
    const mock = mockPayPal().on('POST', `${P}/adjudicate`, { status: 200, json: subsequentAction });
    const { client } = testClient(mock);
    await expect(client.sandbox.adjudicate(inquiry, 'BUYER_FAVOR')).rejects.toBeInstanceOf(
      PayPalActionUnavailableError,
    );
    expect(mock.calls).toHaveLength(0);
    await client.sandbox.adjudicate(underReview, 'SELLER_FAVOR');
    expect(jsonOf(mock.api()[0]!)).toEqual({ adjudication_outcome: 'SELLER_FAVOR' });
  });

  it('requires evidence from the seller', async () => {
    const mock = mockPayPal().on('POST', `${P}/require-evidence`, { status: 200, json: subsequentAction });
    const { client } = testClient(mock);
    await client.sandbox.requireEvidence(underReview, 'SELLER_EVIDENCE');
    expect(jsonOf(mock.api()[0]!)).toEqual({ action: 'SELLER_EVIDENCE' });
    await expect(
      client.sandbox.requireEvidence(underReview, 'BOTH' as 'BUYER_EVIDENCE'),
    ).rejects.toBeInstanceOf(PayPalValidationError);
  });
});

describe('buyer side', () => {
  it('builds an unsigned alg-none JWT with iss and email', () => {
    const jwt = buildAuthAssertion('AZgbuClientId', { email: 'sb-rk-buyer@personal.example.com' });
    expect(jwt.endsWith('.')).toBe(true);
    const [h, p, sig] = jwt.split('.');
    expect(sig).toBe('');
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({ alg: 'none', typ: 'JWT' });
    expect(JSON.parse(Buffer.from(p!, 'base64url').toString())).toEqual({
      iss: 'AZgbuClientId',
      email: 'sb-rk-buyer@personal.example.com',
    });
    expect(jwt).not.toMatch(/[+/=]/);
  });

  it('matches the sample header from the live disputes docs byte for byte', () => {
    expect(buildAuthAssertion('AZgbuClientId', { email: 'b@x.com' }).split('.')[0]).toBe(
      'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0',
    );
  });

  it('supports a payer_id subject and refuses an empty one', () => {
    const p = buildAuthAssertion('cid', { payerId: 'QYR5Z8XDVJNXQ' }).split('.')[1]!;
    expect(JSON.parse(Buffer.from(p, 'base64url').toString())).toEqual({
      iss: 'cid',
      payer_id: 'QYR5Z8XDVJNXQ',
    });
    expect(() => buildAuthAssertion('cid', {} as { email: string })).toThrow(PayPalValidationError);
  });

  it('creates a dispute: multipart input JSON with the auth assertion header, id from the self link', async () => {
    const mock = mockPayPal().on('POST', '/v1/customer/disputes', { status: 201, json: disputeCreated });
    const { client } = testClient(mock);
    const buyer = client.buyer({ email: 'sb-rk-buyer@personal.example.com' });
    const created = await buyer.create({
      buyerTransactionId: '2NJ45340EV624100G',
      reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED',
      disputeAmount: usd(2000),
      merchantContacted: true,
      merchantContactedOutcome: 'NO_RESPONSE',
      issueType: 'PRODUCT',
      notes: 'The shirt is green, not blue.',
      files: [{ filename: 'unboxing.jpg', contentType: 'image/jpeg', data: JPEG }],
      requestId: 'sl-dsp-1',
    });
    expect(created.disputeId).toBe('PP-D-27803');
    const call = mock.api()[0]!;
    expect(call.headers['paypal-auth-assertion']).toBe(buyer.authAssertion);
    expect(call.headers['paypal-request-id']).toBe('sl-dsp-1');
    const parts = parseMultipart(call.rawBody as Uint8Array, call.headers['content-type']!);
    expect(parts[0]!.name).toBe('input');
    expect(parts[0]!.contentType).toBe('application/json');
    expect(JSON.parse(parts[0]!.text)).toEqual({
      disputed_transactions: [{ buyer_transaction_id: '2NJ45340EV624100G' }],
      reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED',
      dispute_amount: { currency_code: 'USD', value: '20.00' },
      extensions: {
        merchant_contacted: true,
        merchant_contacted_outcome: 'NO_RESPONSE',
        merchandize_dispute_properties: { issue_type: 'PRODUCT' },
      },
      evidences: [{ notes: 'The shirt is green, not blue.' }],
    });
    expect(parts[1]!.name).toBe('file1');
  });

  it('rejects unknown reasons and bad transaction ids locally', () => {
    expect(() =>
      buildCreateDisputeInput({
        buyerTransactionId: '2NJ45340EV624100G',
        reason: 'WRONG_COLOUR' as 'OTHER',
        disputeAmount: usd(1),
      }),
    ).toThrow(PayPalValidationError);
    expect(() =>
      buildCreateDisputeInput({ buyerTransactionId: 'bad id', reason: 'OTHER', disputeAmount: usd(1) }),
    ).toThrow(PayPalValidationError);
  });

  it('accepts an offer with a required request id, gated on the buyer view', async () => {
    const mock = mockPayPal()
      .on('GET', P, { status: 200, json: disputeOfferForBuyer })
      .on('POST', `${P}/accept-offer`, { status: 200, json: subsequentAction });
    const { client } = testClient(mock);
    const buyer = client.buyer({ assertion: 'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJ4IjoxfQ.' });
    await expect(buyer.acceptOffer(ID, { requestId: '' })).rejects.toBeInstanceOf(PayPalValidationError);
    await buyer.acceptOffer(ID, { requestId: 'sl-acc-1', note: 'I am ok with the refund offered.' });
    const [get, post] = mock.api();
    expect(get!.headers['paypal-auth-assertion']).toBe('eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJ4IjoxfQ.');
    expect(post!.headers['paypal-auth-assertion']).toBe('eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJ4IjoxfQ.');
    expect(post!.headers['paypal-request-id']).toBe('sl-acc-1');
    expect(jsonOf(post!)).toEqual({ note: 'I am ok with the refund offered.' });
  });

  it('cannot accept an offer that is not on the table', async () => {
    const mock = mockPayPal();
    const buyer = testClient(mock).client.buyer({ email: 'b@personal.example.com' });
    await expect(buyer.acceptOffer(inquiry, { requestId: 'x' })).rejects.toBeInstanceOf(
      PayPalActionUnavailableError,
    );
    await expect(buyer.denyOffer(inquiry, { note: 'Too low' })).rejects.toBeInstanceOf(
      PayPalActionUnavailableError,
    );
    expect(mock.calls).toHaveLength(0);
  });

  it('changes the reason as multipart without link gating (sandbox only)', async () => {
    const mock = mockPayPal().on('POST', `${P}/change-reason`, { status: 200, json: subsequentAction });
    await testClient(mock).client.buyer({ email: 'b@personal.example.com' }).changeReason(inquiry, {
      reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED',
      note: 'Product is not as advertised',
    });
    const call = mock.api()[0]!;
    const parts = parseMultipart(call.rawBody as Uint8Array, call.headers['content-type']!);
    expect(JSON.parse(parts[0]!.text)).toEqual({
      reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED',
      note: 'Product is not as advertised',
    });
  });
});

describe('evidence files', () => {
  it('accepts JPG, PNG, GIF and PDF with matching content', () => {
    expect(() =>
      validateEvidenceFiles([
        { filename: 'a.jpg', contentType: 'image/jpeg', data: JPEG },
        { filename: 'b.jpeg', contentType: 'image/jpeg', data: JPEG },
        { filename: 'c.png', contentType: 'image/png', data: PNG },
        { filename: 'd.gif', contentType: 'image/gif', data: new TextEncoder().encode('GIF89a...') },
        { filename: 'e.pdf', contentType: 'application/pdf', data: PDF },
      ]),
    ).not.toThrow();
  });

  it('rejects wrong types, mismatched extensions, spoofed content, bad names and empty files', () => {
    const bad = [
      { filename: 'a.heic', contentType: 'image/heic', data: JPEG },
      { filename: 'a.png', contentType: 'image/jpeg', data: JPEG },
      { filename: 'a.png', contentType: 'image/png', data: PDF },
      { filename: 'a/../b.png', contentType: 'image/png', data: PNG },
      { filename: 'a\r\nX-Evil: 1.png', contentType: 'image/png', data: PNG },
      { filename: 'a.png', contentType: 'image/png', data: new Uint8Array() },
    ];
    for (const f of bad) expect(() => validateEvidenceFiles([f])).toThrow(PayPalValidationError);
  });

  it('enforces under 10 MB per file and 50 MB per call', () => {
    const big = new Uint8Array(10 * 1024 * 1024);
    big.set(PNG);
    expect(() =>
      validateEvidenceFiles([{ filename: 'big.png', contentType: 'image/png', data: big }]),
    ).toThrow(/10 MB/);
    const nine = new Uint8Array(9 * 1024 * 1024);
    nine.set(PNG);
    const six = Array.from({ length: 6 }, (_, i) => ({
      filename: `p${i}.png`,
      contentType: 'image/png',
      data: nine,
    }));
    expect(() => validateEvidenceFiles(six)).toThrow(/50 MB/);
    expect(() => validateEvidenceFiles(six.slice(0, 5))).not.toThrow();
  });
});
