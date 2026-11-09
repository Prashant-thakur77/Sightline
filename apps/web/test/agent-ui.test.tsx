// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnnouncerProvider } from '@/components/a11y/announcer';
import { AgentTimelineList } from '@/components/orders/agent-timeline-list';
import { AgentProposal } from '@/components/merchant/agent-proposal';
import type { TimelineStep } from '@/server/timeline';
import type { MerchantCase } from '@/server/merchant';

/* The timeline is one ordered list in words, and opening the earlier steps moves focus to the first.
   The store agent's proposal says why, waits for Send, Change or Dismiss, and asks before sending. */

const settle = () =>
  act(async () => {
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 10));
  });
afterEach(cleanup);

const step = (i: number, over: Partial<TimelineStep> = {}): TimelineStep => ({
  key: `k${i}`,
  seq: i,
  at: '2026-11-09T15:04:00.000Z',
  when: 'Monday 9 November, 3:04 pm UTC',
  action: 'agent.step',
  who: 'agent',
  whoWords: 'Your agent',
  what: `Step number ${i}.`,
  tool: null,
  decided: null,
  paypal: null,
  ...over,
});

describe('AgentTimelineList', () => {
  it('says who, what, when, the tool, who decided and PayPal’s id and status, in words', () => {
    render(
      <AnnouncerProvider>
        <h2 id="h">What your agent did</h2>
        <AgentTimelineList
          labelledBy="h"
          steps={[
            step(1, { who: 'paypal', whoWords: 'PayPal', what: 'Put $36.72 on hold.', tool: 'PayPal Orders API', paypal: { label: 'Authorization', id: 'AU-1', status: 'CREATED', source: 'answer' } }),
            step(2, { who: 'store_agent', whoWords: 'The store’s agent', what: 'Proposed: Offer a replacement.', tool: 'Claude', decided: 'model' }),
          ]}
        />
      </AnnouncerProvider>,
    );
    const list = screen.getByRole('list', { name: 'What your agent did' });
    expect(list.tagName).toBe('OL');
    const items = within(list).getAllByRole('listitem');
    expect(items[0]!.textContent).toBe(
      'PayPal: Put $36.72 on hold.Monday 9 November, 3:04 pm UTC. Used PayPal Orders API.Authorization AU-1: created, as PayPal answered.',
    );
    expect(items[1]!.textContent).toContain('The store’s agent: Proposed: Offer a replacement.');
    expect(items[1]!.textContent).toContain('Decided by Claude, a model, and checked by code.');
  });

  it('shows the latest steps of a long list, and opening the rest moves focus to the first step', async () => {
    render(
      <AnnouncerProvider>
        <h2 id="h">What your agent did</h2>
        <AgentTimelineList labelledBy="h" steps={Array.from({ length: 12 }, (_, i) => step(i + 1))} />
      </AnnouncerProvider>,
    );
    expect(screen.getByText('Showing the latest 6 of 12 steps.')).toBeTruthy();
    const list = screen.getByRole('list', { name: 'What your agent did' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(6);
    expect(list.getAttribute('start')).toBe('7');
    const button = screen.getByRole('button', { name: 'Show all 12 steps' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(button);
    await settle();
    const all = within(list).getAllByRole('listitem');
    expect(all).toHaveLength(12);
    expect(document.activeElement).toBe(all[0]);
    expect(all[0]!.textContent).toContain('Step number 1.');
    expect(screen.getByRole('button', { name: 'Show only the latest 6 steps' }).getAttribute('aria-expanded')).toBe('true');
  });
});

const kase = (over: Partial<MerchantCase['agent']> = {}): MerchantCase =>
  ({
    id: 'cas_1',
    ref: 'CAS1',
    buyer: 'Maya',
    item: 'Harbor knit crew-neck sweater',
    amount: '$36.72',
    open: true,
    refundPath: 'void',
    dispute: null,
    agent: {
      on: true,
      thinking: false,
      handedOver: null,
      canAsk: false,
      history: [],
      choices: [
        { id: 'replacement', title: 'Offer a replacement', means: 'A new one at no cost.' },
        { id: 'refund', title: 'Release the $36.72 hold', means: 'The hold is released now.' },
        { id: 'partial_20', title: 'Take $7.34 off if they keep it', means: 'Kept for $29.38.' },
      ],
      pending: {
        id: 'sap_1',
        round: 1,
        status: 'proposed',
        optionId: 'replacement',
        title: 'Offer a replacement',
        amount: null,
        reasons: ["Demo Store's shipping record says it sent the wrong size (L)."],
        staffNote: 'The store sent the wrong size.',
        source: 'model',
        auto: false,
        staffWhy: 'The order is over your $10.00 limit, so staff decide.',
        checkNotes: [],
        result: null,
        decidedBy: null,
        createdAt: '2026-11-09T15:04:00.000Z',
        decidedAt: null,
      },
      ...over,
    },
  }) as unknown as MerchantCase;

describe('AgentProposal', () => {
  it('asks before sending, with focus on the question, and sends only after Yes', async () => {
    const onAct = vi.fn(() => Promise.resolve());
    render(<AgentProposal c={kase()} h="case-1-h" busy={false} anyBusy={false} onAct={onAct} />);
    expect(screen.getByRole('group', { name: 'Offer a replacement' })).toBeTruthy();
    expect(screen.getByText("Demo Store's shipping record says it sent the wrong size (L).")).toBeTruthy();
    expect(screen.getByText(/It waits for you because: The order is over your \$10\.00 limit/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Send the proposal: Offer a replacement' }));
    await settle();
    expect(document.activeElement?.textContent).toBe('Offer Maya a replacement?');
    expect(onAct).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, offer a replacement' }));
    await settle();
    expect(onAct).toHaveBeenCalledWith({ do: 'send', proposalId: 'sap_1', confirm: true });
  });

  it('Change offers only the other allowed replies, and Escape puts focus back on Change', async () => {
    const onAct = vi.fn(() => Promise.resolve());
    render(<AgentProposal c={kase()} h="case-1-h" busy={false} anyBusy={false} onAct={onAct} />);
    const change = screen.getByRole('button', { name: 'Change to another reply' });
    fireEvent.click(change);
    await settle();
    expect(document.activeElement?.textContent).toBe('Choose another reply');
    expect(screen.getAllByRole('radio').map((r) => (r as HTMLInputElement).value)).toEqual(['refund', 'partial_20']);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await settle();
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Change to another reply' }));

    fireEvent.click(screen.getByRole('button', { name: 'Change to another reply' }));
    await settle();
    fireEvent.click(screen.getByRole('radio', { name: 'Release the $36.72 hold' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send this instead' }));
    await settle();
    expect(document.activeElement?.textContent).toBe('Release Maya’s $36.72 hold?');
    fireEvent.click(screen.getByRole('button', { name: 'Yes, release $36.72' }));
    await settle();
    expect(onAct).toHaveBeenCalledWith({ do: 'change', proposalId: 'sap_1', optionId: 'refund', confirm: true });
  });

  it('says when the agent handed the case over, or offers to ask it', () => {
    const { rerender } = render(
      <AgentProposal c={kase({ pending: null, handedOver: 'The revised offer was declined too, so the store agent handed the case to store staff.' })} h="h" busy={false} anyBusy={false} onAct={vi.fn()} />,
    );
    expect(screen.getByText(/handed the case to store staff\. Reply with the buttons below\./)).toBeTruthy();
    rerender(<AgentProposal c={kase({ pending: null, canAsk: true })} h="h" busy={false} anyBusy={false} onAct={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Ask your store agent to propose a reply' })).toBeTruthy();
  });
});
