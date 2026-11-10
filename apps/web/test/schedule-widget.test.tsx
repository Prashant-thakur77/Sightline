// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildSchedule, type ScheduleOrderFacts } from '@/server/schedule';

/* The real Bryntum Scheduler, mounted in jsdom: the config is accepted (no unknown or higher-tier
   feature), it is read-only and named. Its renderer puts words and tone on every bar, and choosing a
   bar or pressing Enter on it goes to the order's case. Layout and colour need a browser. */

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(document, 'fonts', {
    value: { ready: Promise.resolve(), addEventListener() {}, removeEventListener() {} },
    configurable: true,
  });
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }));
});
afterEach(cleanup);

const NOW = new Date();
const at = (days: number) => new Date(NOW.getTime() + days * 86_400_000).toISOString();
const order: ScheduleOrderFacts = {
  id: 'ord_widget_1',
  title: 'Harbor knit crew-neck sweater',
  buyer: 'Maya',
  amountCents: 3672,
  currency: 'USD',
  intent: 'AUTHORIZE',
  status: 'case_open',
  authorizationId: 'AUTH-1',
  captureId: null,
  createdAt: at(-2),
  updatedAt: at(-1),
  deliveredAt: at(-1),
  verdict: 'mismatch',
  kase: {
    id: 'cas_w',
    kind: 'void',
    stage: 'seller_contacted',
    dueAt: at(2),
    createdAt: at(-1),
    updatedAt: at(-1),
    offers: [],
    outcome: null,
  },
  happenings: [{ action: 'case.return_requested', at: at(-1), payload: { dueAt: at(2) } }],
};
const schedule = buildSchedule([order], NOW);

describe('ScheduleWidget (Bryntum Scheduler)', () => {
  it('mounts read-only and named, one row per order, with no config errors', async () => {
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a) => errors.push(a));
    const warns: unknown[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((...a) => warns.push(a));
    const { default: ScheduleWidget } = await import('@/components/merchant/schedule-widget');
    const { container } = render(<ScheduleWidget schedule={schedule} label="Holds and deadlines schedule" />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });
    spy.mockRestore();
    warn.mockRestore();
    expect(container.querySelector('.b-scheduler.b-auto-height'), 'Bryntum rendered a scheduler').toBeTruthy();
    // A named group of bar buttons, not a data grid: the table after it is the structured view.
    expect(container.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe('Holds and deadlines schedule');
    expect(container.querySelector('[role="grid"], [role="rowgroup"], [role="row"], [role="gridcell"]')).toBeNull();
    expect(container.querySelectorAll('.b-grid-sub-grid.b-read-only')).toHaveLength(2);
    expect(container.querySelectorAll('.b-grid-row[data-id="ord_widget_1"]').length).toBeGreaterThan(0);
    // Bryntum reports a bad config (an unknown feature, or one from a higher tier) on the console.
    expect(errors).toEqual([]);
    expect(warns.filter((w) => !/licen[cs]e|trial/i.test(String(w)))).toEqual([]);
  });

  it('turns grid roles into none, drops their grid attributes and hides milestone captions', async () => {
    const { tidyRoles } = await import('@/components/merchant/schedule-widget');
    const root = document.createElement('div');
    root.innerHTML =
      '<div role="grid" aria-label="x" aria-rowcount="3"><div role="rowgroup"><div role="row" aria-rowindex="1">' +
      '<div role="gridcell" aria-readonly="true">A</div></div>' +
      '<div role="button" aria-label="Bar"><label role="presentation">Bar</label></div></div></div>';
    tidyRoles(root);
    expect(root.querySelectorAll('[role="none"]')).toHaveLength(4);
    expect(root.querySelector('[aria-rowcount], [aria-rowindex], [aria-readonly]')).toBeNull();
    expect(root.querySelector('[role="none"][aria-label]')).toBeNull();
    expect(root.querySelector('[role="button"]')?.getAttribute('aria-label')).toBe('Bar');
    const label = root.querySelector('label')!;
    expect(label.hasAttribute('role')).toBe(false);
    expect(label.getAttribute('aria-hidden')).toBe('true');
  });

  it('draws each event with its words, tone and status, and names it in full', async () => {
    const { schedulerConfig } = await import('@/components/merchant/schedule-widget');
    const config = schedulerConfig(schedule, 'x', () => {});
    const reply = schedule.rows[0]!.events.find((e) => e.kind === 'reply_by')!;
    const renderData = { wrapperCls: 'b-sch-event-wrap', ariaLabel: '' } as Record<string, unknown>;
    const out = config.eventRenderer!({ eventRecord: { id: reply.id, name: reply.text }, renderData } as never);
    expect(String(renderData.wrapperCls)).toContain('sl-tone-deadline');
    expect(String(renderData.wrapperCls)).toContain('sl-status-planned');
    expect(renderData.ariaLabel).toBe(reply.name);
    expect(reply.name).toMatch(
      /^Deadline: Store reply by, planned\. .+ UTC\. .+ Press Enter to open case .+ on the cases desk\.$/,
    );
    expect(JSON.stringify(out)).toContain('Store reply by');
    expect(JSON.stringify(out)).toContain('Planned');
    // A moment's name is the text Bryntum measures and draws beside the diamond.
    expect((config.events as { id: string; name: string }[]).find((e) => e.id === reply.id)?.name).toBe(
      'Store reply by · Planned',
    );
  });

  it('goes to the case on a click or Enter on a bar, and nowhere on other keys', async () => {
    const { schedulerConfig } = await import('@/components/merchant/schedule-widget');
    const go = vi.fn();
    const config = schedulerConfig(schedule, 'x', go);
    const ev = schedule.rows[0]!.events[0]!;
    const onKey = config.onEventKeyDown as (e: unknown) => void;
    const onClick = config.onEventClick as (e: unknown) => void;
    const key = (k: string) => ({ key: k, preventDefault: vi.fn() });
    onKey({ eventRecords: [{ id: ev.id }], event: key('ArrowRight') });
    expect(go).not.toHaveBeenCalled();
    onKey({ eventRecords: [{ id: ev.id }], event: key('Enter') });
    expect(go).toHaveBeenLastCalledWith('/merchant/disputes#case-cas_w');
    onClick({ eventRecord: { id: ev.id } });
    expect(go).toHaveBeenCalledTimes(2);
    // Nothing can be changed from the schedule.
    expect(config.readOnly).toBe(true);
    for (const f of [
      'eventDragFeature',
      'eventResizeFeature',
      'eventDragCreateFeature',
      'eventEditFeature',
      'eventMenuFeature',
    ] as const)
      expect(config[f]).toBe(false);
  });
});
