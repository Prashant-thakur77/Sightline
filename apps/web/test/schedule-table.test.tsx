// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ScheduleTable } from '@/components/merchant/schedule-table';
import { buildSchedule, type ScheduleOrderFacts } from '@/server/schedule';
import { spokenWhen } from '@/lib/when';

/* The schedule as a table is what a screen reader uses: a caption, column and row headers, one row
   group per order with the way to its case, and every date said the way the app says dates. */

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

beforeAll(() => {
  // jsdom has no layout: the table's box never scrolls sideways here.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(cleanup);

const NOW = new Date('2026-11-09T12:00:00.000Z');
const at = (days: number) => new Date(NOW.getTime() + days * 86_400_000).toISOString();
const base = (o: Partial<ScheduleOrderFacts>): ScheduleOrderFacts => ({
  id: 'ord_a',
  title: 'Harbor knit crew-neck sweater',
  buyer: 'Maya',
  amountCents: 3672,
  currency: 'USD',
  intent: 'AUTHORIZE',
  status: 'authorized',
  authorizationId: 'AUTH-1',
  captureId: null,
  createdAt: at(-1),
  updatedAt: at(-1),
  deliveredAt: null,
  verdict: null,
  kase: null,
  happenings: [],
  ...o,
});

const schedule = buildSchedule(
  [
    base({ id: 'ord_held_one', createdAt: at(-2), deliveredAt: at(-1) }),
    base({
      id: 'ord_case_two',
      status: 'case_open',
      createdAt: at(-5),
      deliveredAt: at(-3),
      verdict: 'mismatch',
      kase: {
        id: 'cas_two',
        kind: 'void',
        stage: 'seller_contacted',
        dueAt: at(1),
        createdAt: at(-1),
        updatedAt: at(-1),
        offers: [],
        outcome: null,
      },
      happenings: [{ action: 'case.return_requested', at: at(-1), payload: { dueAt: at(1) } }],
    }),
  ],
  NOW,
);

describe('ScheduleTable', () => {
  it('has a caption and column headers', () => {
    render(<ScheduleTable schedule={schedule} id="t" />);
    const table = screen.getByRole('table');
    expect(table.querySelector('caption')?.textContent).toMatch(
      /^Holds and deadlines by order: 2 orders, \d+ entries\. Soonest deadline first\. Times are in UTC\.$/,
    );
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => [h.textContent, h.getAttribute('scope')]),
    ).toEqual([
      ['What', 'col'],
      ['When', 'col'],
      ['Kind', 'col'],
      ['Status', 'col'],
    ]);
  });

  it('groups the rows by order, soonest deadline first, each group headed by its order and the way to its case', () => {
    const { container } = render(<ScheduleTable schedule={schedule} id="t" />);
    const groups = [...container.querySelectorAll('tbody')];
    expect(groups).toHaveLength(2);
    const heads = groups.map((g) => g.querySelector('th[scope="rowgroup"]')!);
    expect(heads.every((h) => h.getAttribute('colspan') === '4')).toBe(true);
    // The case's reply is due tomorrow; the other order's reminder is days away.
    expect(heads[0]!.textContent).toMatch(
      /^Order .+: Harbor knit crew-neck sweater\$36\.72 · Maya · On hold, case open/,
    );
    expect(heads[1]!.textContent).toMatch(/· On hold(?!,)/);
    const link = within(heads[0] as HTMLElement).getByRole('link');
    expect(link.getAttribute('href')).toBe('/merchant/disputes#case-cas_two');
    expect(link.textContent).toMatch(/^Open case .+ on the cases desk$/);
    expect(
      within(heads[1] as HTMLElement)
        .getByRole('link')
        .getAttribute('href'),
    ).toBe('/merchant');
  });

  it('gives every entry a row header, a spoken date, its kind in words and its status in words', () => {
    const { container } = render(<ScheduleTable schedule={schedule} id="t" />);
    const rows = schedule.rows.flatMap((r) => r.events);
    const trs = [...container.querySelectorAll('tbody tr[data-tone]')];
    expect(trs).toHaveLength(rows.length);
    trs.forEach((tr, i) => {
      const e = rows[i]!;
      const th = tr.querySelector('th[scope="row"]')!;
      expect(th.textContent).toBe(`${e.label}${e.detail}`);
      const [when, kind, status] = [...tr.querySelectorAll('td')].map((td) => td.textContent);
      expect(when).toBe(e.end ? `${spokenWhen(e.start)} to ${spokenWhen(e.end)}` : spokenWhen(e.start));
      expect(kind).toMatch(new RegExp(`${e.toneWords}$`));
      expect(status).toBe(e.statusWords);
    });
    // The shape beside each kind is decoration: the word carries it.
    expect(
      [...container.querySelectorAll('.mx-sched-glyph')].every(
        (g) => g.getAttribute('aria-hidden') === 'true',
      ),
    ).toBe(true);
  });

  it('says so in words when there is nothing to schedule', () => {
    render(<ScheduleTable schedule={buildSchedule([], NOW)} id="t" />);
    expect(screen.queryByRole('table')).toBeNull();
    expect(
      screen.getByText('Nothing on hold and no case open, so there is nothing to schedule.'),
    ).toBeTruthy();
  });
});
