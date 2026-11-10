// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScheduleView } from '@/components/merchant/schedule-view';
import { buildSchedule } from '@/server/schedule';

/* The timeline sits in a labelled region with a way past it, and its key says each kind in words. */

vi.mock('@/components/merchant/schedule-widget', () => ({
  default: ({ label }: { label: string }) => <div data-testid="widget">{label}</div>,
}));
afterEach(cleanup);

describe('ScheduleView', () => {
  const schedule = buildSchedule([], new Date('2026-11-09T12:00:00.000Z'));

  it('is a region named by its heading, with a skip link to the table', () => {
    render(<ScheduleView schedule={schedule} skipTo="sched-table-h" />);
    const region = screen.getByRole('region', { name: 'Schedule' });
    const skip = within(region).getByRole('link', { name: 'Skip past the schedule' });
    expect(skip.getAttribute('href')).toBe('#sched-table-h');
    // The skip link comes before the widget's box in reading and Tab order.
    const box = region.querySelector('.mx-sched-box')!;
    expect(skip.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('has a key that says each kind in words, with its shape hidden from screen readers', () => {
    render(<ScheduleView schedule={schedule} skipTo="x" />);
    const key = screen.getByRole('list', { name: 'Key' });
    const items = within(key).getAllByRole('listitem');
    expect(items.map((li) => li.textContent?.replace(/^[▬◆✓]/, ''))).toEqual([
      'Hold: money PayPal is holding, and each honour period',
      'Deadline: a renewal, reminder, auto-capture, reply or offer that is due',
      'Done: what actually happened, with its time',
    ]);
    expect(items.every((li) => li.querySelector('[aria-hidden="true"]'))).toBe(true);
  });

  it('loads the timeline in the browser with its accessible name', async () => {
    render(<ScheduleView schedule={schedule} skipTo="x" />);
    expect((await screen.findByTestId('widget')).textContent).toBe('Holds and deadlines schedule');
  });
});
