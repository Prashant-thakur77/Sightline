'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { BryntumScheduler, type BryntumSchedulerProps } from '@bryntum/scheduler-react-business';
import '@bryntum/scheduler-business/scheduler.css';
import '@bryntum/scheduler-business/svalbard.css';
import './bryntum-theme.css';
import type { Schedule } from '@/server/schedule';

/**
 * The Bryntum Scheduler config for the store's holds and deadlines: one row per order, the hold in
 * cobalt, deadlines in peach, what happened in night, a line for now. Read-only: nothing here moves
 * money. Choosing a bar, or Enter on it, calls go with the order's case on the cases desk.
 */
export function schedulerConfig(
  schedule: Schedule,
  label: string,
  go: (href: string) => void,
): BryntumSchedulerProps {
  const byId = new Map(schedule.rows.flatMap((r) => r.events.map((e) => [e.id, { e, r }] as const)));
  return {
    ariaLabel: label,
    // The stylesheets are bundled with the page (imports above); never fetch Bryntum's from a CDN.
    detectCSSCompatibilityIssues: false,
    readOnly: true,
    autoHeight: true,
    timeZone: 'UTC',
    startDate: new Date(schedule.start),
    endDate: new Date(schedule.end),
    viewPreset: { base: 'dayAndWeek', tickWidth: 74 },
    rowHeight: 48,
    barMargin: 6,
    eventLayout: 'stack',
    eventStyle: 'filled',
    milestoneLayoutMode: 'measure',
    milestoneTextPosition: 'always-outside',
    useInitialAnimation: false,
    zoomOnMouseWheel: false,
    zoomOnTimeAxisDoubleClick: false,
    emptyText: 'Nothing on hold and no case open.',
    columns: [
      {
        text: 'Order',
        field: 'name',
        // Narrow screens keep most of the width for the timeline itself.
        width: typeof window !== 'undefined' && window.innerWidth < 640 ? '7.5em' : '11em',
        sortable: false,
        groupable: false,
        renderer: ({ record }: { record: { getData: (f: string) => unknown } }) => ({
          className: 'sl-sched-order',
          children: [
            { tag: 'span', className: 'sl-sched-order-name', text: String(record.getData('name') ?? '') },
            { tag: 'span', className: 'sl-sched-order-state', text: String(record.getData('state') ?? '') },
          ],
        }),
      },
    ],
    resources: schedule.rows.map((r) => ({
      id: r.orderId,
      name: `${r.orderRef} · ${r.title}`,
      state: `${r.amount} · ${r.stateWords}`,
    })),
    events: schedule.rows.flatMap((r) =>
      r.events.map((e) => ({
        id: e.id,
        resourceId: r.orderId,
        // Bryntum measures a diamond's words from the name, so it is the text drawn beside it.
        name: e.text,
        startDate: new Date(e.start),
        endDate: new Date(e.end ?? e.start),
      })),
    ),
    eventRenderer: ({ eventRecord, renderData }) => {
      const hit = byId.get(String(eventRecord.id));
      if (!hit) return eventRecord.name;
      const { e } = hit;
      renderData.wrapperCls = `${String(renderData.wrapperCls ?? '')} sl-tone-${e.tone} sl-status-${e.status}`;
      renderData.ariaLabel = e.name;
      // A bar shorter than five days has room for its name only; the status is in its accessible
      // name, its tooltip and the table.
      const short = e.end != null && Date.parse(e.end) - Date.parse(e.start) < 5 * 86_400_000;
      return short
        ? [{ tag: 'span', className: 'sl-ev-label', text: e.label }]
        : [
            { tag: 'span', className: 'sl-ev-label', text: e.label },
            { tag: 'span', className: 'sl-ev-status', text: ` · ${e.statusWords}` },
          ];
    },
    // Nothing to edit: no drag, resize, create, menus or editors. Bryntum's keyboard model stays:
    // Tab into the grid, arrow keys between bars, Enter on a bar.
    eventDragFeature: false,
    eventResizeFeature: false,
    eventDragCreateFeature: false,
    eventEditFeature: false,
    eventMenuFeature: false,
    scheduleMenuFeature: false,
    cellMenuFeature: false,
    headerMenuFeature: false,
    timeAxisHeaderMenuFeature: false,
    cellEditFeature: false,
    scheduleTooltipFeature: false,
    sortFeature: false,
    columnReorderFeature: false,
    eventTooltipFeature: {
      template: ({ eventRecord }: { eventRecord: { id: string | number } }) => {
        const hit = byId.get(String(eventRecord.id));
        return hit ? hit.e.name : '';
      },
    },
    timeRangesFeature: { showCurrentTimeLine: { name: 'Now' }, showHeaderElements: true },
    onEventClick: ({ eventRecord }) => {
      const hit = byId.get(String(eventRecord.id));
      if (hit) go(hit.r.href);
    },
    onEventKeyDown: ({ eventRecords, event }) => {
      if (event.key !== 'Enter') return;
      const hit = eventRecords[0] && byId.get(String(eventRecords[0].id));
      if (hit) {
        event.preventDefault();
        go(hit.r.href);
      }
    },
  };
}

/** The scheduler itself, loaded only in the browser (see ScheduleView). */
export default function ScheduleWidget({ schedule, label }: { schedule: Schedule; label: string }) {
  const router = useRouter();
  const props = useMemo(
    () => schedulerConfig(schedule, label, (href) => router.push(href)),
    [schedule, label, router],
  );
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const byId = new Map(schedule.rows.flatMap((r) => r.events.map((e) => [e.id, r.href] as const)));
    // Enter on a focused bar, when Bryntum's own key handler did not already take it.
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Enter' || ev.defaultPrevented) return;
      const id = (ev.target as Element | null)?.closest('[data-event-id]')?.getAttribute('data-event-id');
      const href = id ? byId.get(id) : undefined;
      if (href) {
        ev.preventDefault();
        router.push(href);
      }
    };
    el.addEventListener('keydown', onKey);
    const observer = new MutationObserver(() => tidyRoles(el));
    tidyRoles(el);
    observer.observe(el, { subtree: true, childList: true, attributes: true, attributeFilter: ['role', ...GRID_ATTRS] });
    return () => {
      el.removeEventListener('keydown', onKey);
      observer.disconnect();
    };
  }, [schedule, router]);
  return (
    <div ref={box} className="mx-sched-widget" role="group" aria-label={label}>
      <BryntumScheduler {...props} />
    </div>
  );
}

const GRID_ROLES = new Set(['grid', 'treegrid', 'rowgroup', 'row', 'gridcell', 'columnheader', 'rowheader']);
const GRID_ATTRS = ['aria-label', 'aria-labelledby', 'aria-describedby', 'aria-owns', 'aria-rowindex', 'aria-colindex', 'aria-rowcount', 'aria-colcount', 'aria-selected', 'aria-readonly', 'aria-multiselectable', 'aria-sort'];

/**
 * The timeline is read-only and the same schedule is in the table after it, so it is offered as a
 * named region of buttons, one per bar, rather than a data grid: Bryntum's grid roles would put the
 * bars where a grid allows only rows and cells. Milestone captions repeat the bar's own name, so they
 * are hidden from assistive tech instead of carrying a role a label may not have.
 */
export function tidyRoles(root: Element): void {
  for (const node of root.querySelectorAll('[role]')) {
    const role = node.getAttribute('role')!;
    if (GRID_ROLES.has(role) || role === 'none') {
      if (role !== 'none') node.setAttribute('role', 'none');
      for (const a of GRID_ATTRS) if (node.hasAttribute(a)) node.removeAttribute(a);
    } else if (node.tagName === 'LABEL' && role === 'presentation') {
      node.removeAttribute('role');
      node.setAttribute('aria-hidden', 'true');
    }
  }
}
