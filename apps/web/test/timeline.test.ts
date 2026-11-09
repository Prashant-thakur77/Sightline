import { describe, expect, it } from 'vitest';
import { describeEntry, toolName, type AuditRow } from '../src/server/timeline';

/* Each audit entry as a plain step: who did it, the tool, who decided, and PayPal's own id and status. */

const order = { amountCents: 3672, currency: 'USD' };
let seq = 0;
const row = (action: string, payload: Record<string, unknown> = {}, actor = 'agent'): AuditRow => ({
  seq: ++seq,
  actor,
  action,
  payload: { ...payload, _at: '2026-11-09T15:04:00.000Z' },
  createdAt: '2026-11-09T15:04:01.000Z',
});
const one = (r: AuditRow) => {
  const steps = describeEntry(r, order);
  expect(steps).toHaveLength(1);
  return steps[0]!;
};

describe('describeEntry', () => {
  it('shows the shopping steps another part of the agent records, with their tool', () => {
    const s = one(row('agent.step', { tool: 'channel3.search', step: 'search', summary: 'Searched Channel3 for a navy crew-neck sweater in medium.', conversationId: 'cnv_1' }));
    expect(s).toMatchObject({ who: 'agent', whoWords: 'Your agent', tool: 'Channel3', decided: null, what: 'Searched Channel3 for a navy crew-neck sweater in medium.' });
    expect(s.when).toBe('Monday 9 November, 3:04 pm UTC');
    expect(one(row('agent.step', { tool: 'claude', summary: 'Turned your words into search filters.' })).decided).toBe('model');
  });

  it('keeps who decided a shopping step when the step records it', () => {
    expect(one(row('agent.step', { tool: 'money', step: 'answered', summary: 'Answered from the order records.', decided: 'rules' }))).toMatchObject({ tool: 'Order records', decided: 'rules' });
    expect(one(row('agent.step', { tool: 'memory', step: 'remembered', summary: 'With the buyer’s yes, remembered their size.', decided: 'person' }))).toMatchObject({ tool: 'Saved preferences', decided: 'person' });
    expect(one(row('agent.step', { tool: 'claude', step: 'lines_stopped', summary: 'Left out 2 lines it wrote that the listings don’t back.', decided: 'model' }))).toMatchObject({ tool: 'Claude', decided: 'model' });
    // An unknown value is not trusted.
    expect(one(row('agent.step', { tool: 'catalog', summary: 'Searched the Demo Store.', decided: 'nobody' })).decided).toBeNull();
  });

  it('marks the payment check as fixed rules and the second confirmation key as a model', () => {
    expect(one(row('gate.allowed', {}, 'gate'))).toMatchObject({ who: 'safety', whoWords: 'Sightline’s safety check', decided: 'rules', tool: null });
    const confirmed = describeEntry(row('readback.confirmed', { key1: 'phrase', key2: 'classifier' }, 'user'), order);
    expect(confirmed.map((s) => [s.who, s.decided, s.tool])).toEqual([
      ['you', 'person', null],
      ['safety', 'model', 'Claude'],
    ]);
    expect(new Set(confirmed.map((s) => s.key)).size).toBe(2);
  });

  it('carries PayPal’s own ids and statuses, saying where each status came from', () => {
    expect(one(row('order.created', { paypalOrderId: 'PO-1', paypalStatus: 'PAYER_ACTION_REQUIRED' }, 'paypal')).paypal).toEqual({
      label: 'PayPal order',
      id: 'PO-1',
      status: 'PAYER_ACTION_REQUIRED',
      source: 'answer',
    });
    expect(one(row('payment.authorized', { paypalOrderId: 'PO-1', authorizationId: 'AU-1', paypalStatus: 'CREATED', amount: '$36.72' }, 'paypal'))).toMatchObject({
      what: 'Put $36.72 on hold. Demo Store is paid only after your check.',
      tool: 'PayPal Orders API',
      paypal: { label: 'Authorization', id: 'AU-1', status: 'CREATED', source: 'answer' },
    });
    expect(one(row('webhook.payment.capture.refunded', { eventId: 'WH-1', resourceId: 'RF-1', paypalStatus: 'COMPLETED', verified: true }, 'paypal'))).toMatchObject({
      tool: 'PayPal webhook',
      what: 'Confirmed the refund.',
      paypal: { label: 'Refund', id: 'RF-1', status: 'COMPLETED', source: 'webhook' },
    });
    // An entry from before statuses were recorded says so instead of guessing.
    expect(one(row('payment.captured_after_check', { captureId: 'CA-1' }, 'paypal')).paypal).toEqual({ label: 'Capture', id: 'CA-1', status: null, source: 'answer' });
  });

  it('tells the store’s agent apart from store staff, and who decided each', () => {
    expect(one(row('store_agent.step', { tool: 'Claude', step: 'proposed', summary: 'Proposed: Offer a replacement.', decided: 'model' }, 'store_agent'))).toMatchObject({
      who: 'store_agent',
      whoWords: 'The store’s agent',
      tool: 'Claude',
      decided: 'model',
    });
    expect(one(row('case.offer_made', { offerType: 'REPLACEMENT_WITHOUT_REFUND', via: 'local', by: 'store_agent' }, 'store_agent'))).toMatchObject({
      who: 'store_agent',
      decided: 'rules',
      what: 'Offered a replacement. It was inside the store’s policy, so it was sent without staff.',
    });
    expect(one(row('case.offer_made', { offerType: 'PARTIAL_REFUND', amountCents: 734, via: 'local', by: 'staff' }, 'merchant'))).toMatchObject({
      who: 'staff',
      decided: 'person',
      what: 'Offered $7.34 back if you keep the item.',
    });
    expect(one(row('case.hold_released', { via: 'void', paypalId: 'AU-1', paypalStatus: 'VOIDED', amountCents: 3672, by: 'store_agent' }, 'store_agent'))).toMatchObject({
      who: 'store_agent',
      tool: 'PayPal Payments API',
      paypal: { label: 'Authorization', id: 'AU-1', status: 'VOIDED' },
    });
  });

  it('says a kept-for-less hold without the word refund', () => {
    const s = one(row('case.partial_refunded', { via: 'capture', paypalId: 'CA-9', paypalStatus: 'COMPLETED', amountCents: 734, keptCents: 2938, held: true }, 'paypal'));
    expect(s.what).toBe('Took $29.38 from your hold and released the other $7.34. You kept the item for less.');
    expect(s.paypal).toMatchObject({ label: 'Capture', id: 'CA-9' });
  });

  it('leaves out entries that are not about the order’s journey', () => {
    expect(describeEntry(row('settings.saved', {}, 'user'), order)).toEqual([]);
    expect(describeEntry(row('privacy.photos_deleted', {}, 'user'), order)).toEqual([]);
  });

  it('names tools the same way whatever another component recorded', () => {
    expect(toolName('PayPal Orders API')).toBe('PayPal Orders API');
    expect(toolName('paypal.payments.void')).toBe('PayPal Payments API');
    expect(toolName('Anthropic claude-haiku-5-5')).toBe('Claude');
    expect(toolName('vision service')).toBe('Sightline vision check');
    expect(toolName('catalog')).toBe('Demo Store catalog');
    expect(toolName('memory')).toBe('Saved preferences');
    expect(toolName('money')).toBe('Order records');
    expect(toolName('app')).toBe('Fixed templates');
    expect(toolName('')).toBeNull();
  });
});
