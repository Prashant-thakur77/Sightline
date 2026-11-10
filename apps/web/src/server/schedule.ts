import { formatMoney, shortRef } from '@sightline/core';
import { spokenWhen } from '@/lib/when';
import {
  AUTHORIZATION_DAYS,
  AUTO_CAPTURE_DAYS,
  CASE_SENT_ACTIONS,
  CHECK_REMINDER_DAYS,
  DAY_MS,
  HONOR_PERIOD_DAYS,
  OPEN_STAGES,
  PAID_ACTIONS,
  PARTIAL_REFUND_ACTION,
  REAUTHORIZED_ACTION,
  REFUNDED_ACTIONS,
  RELEASED_ACTIONS,
  REMINDER_ACTION,
  isHeld,
} from './hold-rules';

/*
 * The store's "Holds and deadlines" schedule: for each order with money on hold or a case open,
 * when PayPal's authorization runs, each three-day honour period and the renewal at its end, the
 * day-5 check reminder, the day-7 auto-capture, the case's reply-by and offer deadlines, and what
 * actually happened to the money. Pure: every date comes from the order's own rows, the audit log's
 * times and the hold rules the sweep runs on, so the schedule and the sweep cannot disagree.
 */

/** One audit entry that matters to the schedule, with its time. */
export interface ScheduleHappening {
  action: string;
  at: string;
  payload: unknown;
}

export interface ScheduleCaseFacts {
  id: string;
  kind: string;
  stage: string;
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
  offers: unknown[];
  outcome: unknown;
}

export interface ScheduleOrderFacts {
  id: string;
  title: string;
  buyer: string;
  amountCents: number;
  currency: string;
  intent: string;
  status: string;
  authorizationId: string | null;
  captureId: string | null;
  /** When PayPal authorized the payment: the order's creation, as the hold sweep counts it. */
  createdAt: string;
  updatedAt: string;
  deliveredAt: string | null;
  /** The latest check's verdict kind: match, mismatch, unsure. */
  verdict: string | null;
  /** The order's case as the cases desk lists it (not a draft), if any. */
  kase: ScheduleCaseFacts | null;
  happenings: ScheduleHappening[];
}

export type ScheduleKind =
  | 'authorization'
  | 'honour'
  | 'reauthorize'
  | 'reminder'
  | 'auto_capture'
  | 'reply_by'
  | 'offer_by'
  | 'reauthorized'
  | 'reminded'
  | 'captured'
  | 'released'
  | 'refunded';

/** hold: money PayPal is holding (cobalt). deadline: a date something is due (peach). done: what happened (night). */
export type ScheduleTone = 'hold' | 'deadline' | 'done';
export type ScheduleStatus =
  | 'running'
  | 'ended'
  | 'expired'
  | 'planned'
  | 'overdue'
  | 'paused'
  | 'answered'
  | 'missed'
  | 'settled'
  | 'done';

export const TONE_WORDS: Record<ScheduleTone, string> = { hold: 'Hold', deadline: 'Deadline', done: 'Done' };
export const STATUS_WORDS: Record<ScheduleStatus, string> = {
  running: 'Running now',
  ended: 'Ended',
  expired: 'Expired',
  planned: 'Planned',
  overdue: 'Past due',
  paused: 'Paused',
  answered: 'Answered',
  missed: 'Missed',
  settled: 'Settled',
  done: 'Done',
};

export interface ScheduleEvent {
  id: string;
  orderId: string;
  kind: ScheduleKind;
  tone: ScheduleTone;
  toneWords: string;
  status: ScheduleStatus;
  statusWords: string;
  /** Short, drawn on the bar. */
  label: string;
  /** One sentence on what it means. */
  detail: string;
  start: string;
  /** Null for a moment (a deadline or something that happened). */
  end: string | null;
  /** "Monday 9 November, 2:24 pm UTC", or "… to …" for a span. */
  when: string;
  /** What the bar or diamond says on screen: label and status. */
  text: string;
}

/** An event on a row, with its full accessible name: kind, label, status, when, meaning and where Enter goes. */
export interface ScheduleRowEvent extends ScheduleEvent {
  name: string;
}

export interface ScheduleRow {
  orderId: string;
  orderRef: string;
  title: string;
  buyer: string;
  amount: string;
  caseId: string | null;
  caseRef: string | null;
  /** The order's case on the cases desk, or the Orders page when it has no case. */
  href: string;
  linkWords: string;
  stateWords: string;
  /** Money still on hold or a case still open. */
  active: boolean;
  /** The soonest deadline still to come (or already past due). */
  nextDue: string | null;
  events: ScheduleRowEvent[];
}

export interface Schedule {
  now: string;
  start: string;
  end: string;
  rows: ScheduleRow[];
}

/** The schedule always shows at least this far past now, so an empty or quiet store still has a week ahead. */
const SHOWN_AHEAD_DAYS = 7;
const iso = (ms: number) => new Date(ms).toISOString();
const addDays = (at: string | number, days: number) =>
  (typeof at === 'string' ? Date.parse(at) : at) + days * DAY_MS;
const byTime = (a: ScheduleHappening, b: ScheduleHappening) => Date.parse(a.at) - Date.parse(b.at);

function event(
  o: ScheduleOrderFacts,
  kind: ScheduleKind,
  n: number,
  e: Omit<ScheduleEvent, 'id' | 'orderId' | 'kind' | 'toneWords' | 'statusWords' | 'when' | 'text'>,
): ScheduleEvent {
  const statusWords = STATUS_WORDS[e.status];
  return {
    id: `${o.id}:${kind}:${n}`,
    orderId: o.id,
    kind,
    toneWords: TONE_WORDS[e.tone],
    statusWords,
    when: whenWords(e),
    text: `${e.label} · ${statusWords}`,
    ...e,
  };
}

const cents = (p: unknown, key: string): number | null => {
  const v = (p as Record<string, unknown> | null)?.[key];
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
};

/** How a hold ended, and when: the first time PayPal paid the store, released the hold, or took part of it. */
function holdEnd(
  o: ScheduleOrderFacts,
  hs: ScheduleHappening[],
): { at: string; how: 'paid' | 'released' | 'part' } | null {
  for (const h of hs) {
    if (PAID_ACTIONS.includes(h.action)) return { at: h.at, how: 'paid' };
    if (RELEASED_ACTIONS.includes(h.action)) return { at: h.at, how: 'released' };
    if (h.action === PARTIAL_REFUND_ACTION && (h.payload as { held?: unknown } | null)?.held)
      return { at: h.at, how: 'part' };
  }
  // Settled with no audit entry for it (older rows): the order's last update is when it changed.
  if (o.captureId) return { at: o.updatedAt, how: 'paid' };
  if (o.status === 'voided') return { at: o.updatedAt, how: 'released' };
  return null;
}

const HOW_WORDS = {
  paid: 'paid to the store',
  released: 'released',
  part: 'partly taken and the rest released',
} as const;

/** Every dated thing on one order, in time order. */
export function orderEvents(o: ScheduleOrderFacts, now: Date): ScheduleEvent[] {
  const t = now.getTime();
  const amount = formatMoney({ cents: o.amountCents, currency: o.currency });
  const hs = [...o.happenings].sort(byTime);
  const out: ScheduleEvent[] = [];
  const hadHold = o.intent === 'AUTHORIZE' && Boolean(o.authorizationId);
  const heldNow = isHeld(o);
  const kase = o.kase;
  const caseOpen = Boolean(kase && kase.stage !== 'resolved');
  const voidCase = Boolean(kase && kase.kind === 'void');

  // The case's reply-by: the deadline the buyer's case was sent with, else the case's own while it waits for the store.
  const sent = hs.find(
    (h) =>
      CASE_SENT_ACTIONS.includes(h.action) &&
      typeof (h.payload as { dueAt?: unknown } | null)?.dueAt === 'string',
  );
  const replyDue =
    (sent?.payload as { dueAt?: string } | undefined)?.dueAt ??
    (kase?.stage === 'seller_contacted' ? kase.dueAt : null);
  const offered = Boolean(kase && kase.offers.length > 0 && kase.dueAt);
  const byDeadline = (kase?.outcome as { by?: unknown } | null)?.by === 'deadline';

  if (hadHold) {
    const authorized = o.createdAt;
    const expiry = addDays(authorized, AUTHORIZATION_DAYS);
    const ended = heldNow ? null : holdEnd(o, hs);
    const endMs = ended ? Date.parse(ended.at) : null;

    out.push(
      event(o, 'authorization', 1, {
        tone: 'hold',
        status: ended ? 'ended' : t >= expiry ? 'expired' : 'running',
        label: 'PayPal hold',
        detail: ended
          ? `PayPal held ${amount} until it was ${HOW_WORDS[ended.how]} on ${spokenWhen(ended.at)}.`
          : `PayPal holds ${amount}. The authorization ends on ${spokenWhen(iso(expiry))}, ${AUTHORIZATION_DAYS} days after it began.`,
        start: authorized,
        end: ended ? ended.at : iso(expiry),
      }),
    );

    // Honour periods that began: at authorization, then at each real renewal.
    const renewals = hs.filter(
      (h) => h.action === REAUTHORIZED_ACTION && Date.parse(h.at) <= (endMs ?? Infinity),
    );
    const starts = [authorized, ...renewals.map((r) => r.at)];
    starts.forEach((s, i) => {
      const natural = addDays(s, HONOR_PERIOD_DAYS);
      const stop = Math.min(natural, expiry, endMs ?? Infinity);
      out.push(
        event(o, 'honour', i + 1, {
          tone: 'hold',
          status: endMs !== null || stop <= t ? 'ended' : 'running',
          label: `Honour period ${i + 1}`,
          detail: `PayPal honours the full ${amount} until ${spokenWhen(iso(natural))}.`,
          start: s,
          end: iso(stop),
        }),
      );
    });
    renewals.forEach((r, i) =>
      out.push(
        event(o, 'reauthorized', i + 1, {
          tone: 'done',
          status: 'done',
          label: 'Hold renewed',
          detail: `PayPal reauthorized the hold (renewal ${i + 1}), so the full amount stays honoured.`,
          start: r.at,
          end: null,
        }),
      ),
    );

    const delivered = o.deliveredAt;
    const replacement = Boolean(kase && kase.stage === 'resolved' && o.status === 'resolved_replacement');
    const pausedWhy = caseOpen
      ? 'while the case is open'
      : o.verdict === 'mismatch'
        ? 'because the check found the wrong item'
        : null;

    // When the hold is expected to end, so renewals are planned only until then.
    let planEnd = expiry;
    if (heldNow && caseOpen && voidCase && kase?.dueAt && OPEN_STAGES.has(kase.stage))
      planEnd = Math.min(planEnd, Date.parse(kase.dueAt));
    else if (heldNow && replacement) planEnd = Math.min(planEnd, addDays(kase!.updatedAt, AUTO_CAPTURE_DAYS));
    else if (heldNow && delivered && !pausedWhy)
      planEnd = Math.min(planEnd, addDays(delivered, AUTO_CAPTURE_DAYS));

    // Renewals still to come: PayPal allows none on or after the 29th day. A renewal the sweep has
    // not run yet is past due once; the ones after it count from now, when the next sweep runs.
    if (heldNow && t < expiry) {
      let p = addDays(starts[starts.length - 1]!, HONOR_PERIOD_DAYS);
      let n = renewals.length + 1;
      while (p < expiry && p < planEnd) {
        const from = Math.max(p, t);
        out.push(
          event(o, 'reauthorize', n, {
            tone: 'deadline',
            status: p <= t ? 'overdue' : 'planned',
            label: 'Renew hold',
            detail: `PayPal reauthorizes the hold (renewal ${n}), so a later capture is honoured for the full amount.`,
            start: iso(p),
            end: null,
          }),
        );
        const stop = Math.min(addDays(from, HONOR_PERIOD_DAYS), expiry);
        if (stop > from)
          out.push(
            event(o, 'honour', n + 1, {
              tone: 'hold',
              status: 'planned',
              label: `Honour period ${n + 1}`,
              detail: `If renewed, PayPal honours the full ${amount} until ${spokenWhen(iso(stop))}.`,
              start: iso(from),
              end: iso(stop),
            }),
          );
        p = addDays(from, HONOR_PERIOD_DAYS);
        n++;
      }
    }

    // The day-5 reminder: what was sent, or what is planned while nothing else decides the hold.
    const reminded = hs.find((h) => h.action === REMINDER_ACTION);
    if (reminded)
      out.push(
        event(o, 'reminded', 1, {
          tone: 'done',
          status: 'done',
          label: 'Reminder sent',
          detail: `The buyer was reminded to check the parcel while ${amount} is on hold.`,
          start: reminded.at,
          end: null,
        }),
      );
    else if (heldNow && delivered && !pausedWhy && !replacement) {
      const due = addDays(delivered, CHECK_REMINDER_DAYS);
      out.push(
        event(o, 'reminder', 1, {
          tone: 'deadline',
          status: due <= t ? 'overdue' : 'planned',
          label: `Day-${CHECK_REMINDER_DAYS} check reminder`,
          detail: `The buyer is reminded to check the parcel, ${CHECK_REMINDER_DAYS} days after delivery.`,
          start: iso(due),
          end: null,
        }),
      );
    }

    // The day-7 auto-capture, or a week after an agreed replacement.
    if (heldNow && replacement) {
      const due = addDays(kase!.updatedAt, AUTO_CAPTURE_DAYS);
      out.push(
        event(o, 'auto_capture', 1, {
          tone: 'deadline',
          status: due <= t ? 'overdue' : 'planned',
          label: 'Paid after replacement',
          detail: `The store is paid ${amount} a week after the buyer agreed to a replacement.`,
          start: iso(due),
          end: null,
        }),
      );
    } else if (heldNow && delivered) {
      const due = addDays(delivered, AUTO_CAPTURE_DAYS);
      out.push(
        event(o, 'auto_capture', 1, {
          tone: 'deadline',
          status: pausedWhy ? 'paused' : due <= t ? 'overdue' : 'planned',
          label: `Day-${AUTO_CAPTURE_DAYS} auto-capture`,
          detail: pausedWhy
            ? `The store would be paid ${amount} on this day, ${AUTO_CAPTURE_DAYS} days after delivery. Paused ${pausedWhy}.`
            : `If no problem is reported, the store is paid ${amount}, ${AUTO_CAPTURE_DAYS} days after delivery.`,
          start: iso(due),
          end: null,
        }),
      );
    }
  }

  // The case's deadlines.
  const releasesHold = heldNow && voidCase;
  if (kase && replyDue) {
    const waiting = kase.stage === 'seller_contacted';
    const status: ScheduleStatus = waiting
      ? Date.parse(replyDue) <= t
        ? 'overdue'
        : 'planned'
      : byDeadline && !offered
        ? 'missed'
        : 'answered';
    out.push(
      event(o, 'reply_by', 1, {
        tone: 'deadline',
        status,
        label: 'Store reply by',
        detail:
          status === 'missed'
            ? 'No answer came in time, so the hold was released.'
            : status === 'answered'
              ? 'The store answered the case.'
              : releasesHold
                ? "The store's reply is due. If it hasn't answered by then, the hold is released."
                : "The store's reply is due.",
        start: replyDue,
        end: null,
      }),
    );
  }
  if (kase && offered) {
    const open = OPEN_STAGES.has(kase.stage);
    const due = kase.dueAt!;
    out.push(
      event(o, 'offer_by', 1, {
        tone: 'deadline',
        status: open ? (Date.parse(due) <= t ? 'overdue' : 'planned') : 'settled',
        label: 'Offer answer by',
        detail: !open
          ? 'The case was settled.'
          : releasesHold
            ? "The buyer answers the store's offer by then. If the case isn't settled, the hold is released."
            : "The buyer answers the store's offer by then.",
        start: due,
        end: null,
      }),
    );
  }

  // What actually happened to the money.
  let paid = 0;
  let released = 0;
  let refunded = 0;
  for (const h of hs) {
    if (PAID_ACTIONS.includes(h.action)) {
      if (paid++) continue; // a webhook repeats PayPal's answer: one "Store paid"
      out.push(
        event(o, 'captured', paid, {
          tone: 'done',
          status: 'done',
          label: 'Store paid',
          detail: `PayPal paid the store ${amount}.`,
          start: h.at,
          end: null,
        }),
      );
    } else if (RELEASED_ACTIONS.includes(h.action)) {
      if (released++) continue;
      out.push(
        event(o, 'released', released, {
          tone: 'done',
          status: 'done',
          label: 'Hold released',
          detail: `PayPal released the ${amount} hold. The buyer was never charged.`,
          start: h.at,
          end: null,
        }),
      );
    } else if (REFUNDED_ACTIONS.includes(h.action) || h.action === PARTIAL_REFUND_ACTION) {
      const part = cents(h.payload, 'amountCents');
      const back = part !== null ? formatMoney({ cents: part, currency: o.currency }) : 'the payment';
      const partial = h.action === PARTIAL_REFUND_ACTION;
      out.push(
        event(o, 'refunded', ++refunded, {
          tone: 'done',
          status: 'done',
          label: partial ? 'Kept for less' : 'Refunded',
          detail: partial
            ? `The buyer kept the item for less: PayPal returned ${back}.`
            : `PayPal refunded ${back}.`,
          start: h.at,
          end: null,
        }),
      );
    }
  }

  return out.sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.id.localeCompare(b.id));
}

function stateWords(o: ScheduleOrderFacts, events: ScheduleEvent[], caseOpen: boolean): string {
  if (isHeld(o)) return caseOpen ? 'On hold, case open' : 'On hold';
  if (caseOpen) return 'Case open';
  const last = [...events]
    .reverse()
    .find((e) => e.tone === 'done' && e.kind !== 'reauthorized' && e.kind !== 'reminded');
  if (last?.kind === 'captured') return 'Settled: store paid';
  if (last?.kind === 'released') return 'Settled: hold released';
  if (last?.kind === 'refunded') return 'Settled: refunded';
  return 'Settled';
}

/**
 * The schedule for a store: one row per order with money on hold or a case open, soonest deadline
 * first, then the holds and cases settled inside the last 29 days, so what happened stays in view.
 */
export function buildSchedule(orders: ScheduleOrderFacts[], now: Date): Schedule {
  const t = now.getTime();
  const rows: ScheduleRow[] = [];
  for (const o of orders) {
    const caseOpen = Boolean(o.kase && o.kase.stage !== 'resolved');
    const hadHold = o.intent === 'AUTHORIZE' && Boolean(o.authorizationId);
    const active = isHeld(o) || caseOpen;
    const recent = (hadHold || Boolean(o.kase)) && t - Date.parse(o.createdAt) < AUTHORIZATION_DAYS * DAY_MS;
    if (!active && !recent) continue;
    const events = orderEvents(o, now);
    if (!events.length) continue;
    const due = events.filter(
      (e) => e.tone === 'deadline' && (e.status === 'planned' || e.status === 'overdue'),
    );
    const caseRef = o.kase ? shortRef(o.kase.id) : null;
    const orderRef = shortRef(o.id);
    const linkWords = o.kase ? `Open case ${caseRef} on the cases desk` : 'Open the Orders page';
    rows.push({
      orderId: o.id,
      orderRef,
      title: o.title,
      buyer: o.buyer,
      amount: formatMoney({ cents: o.amountCents, currency: o.currency }),
      caseId: o.kase?.id ?? null,
      caseRef,
      href: o.kase ? `/merchant/disputes#case-${o.kase.id}` : '/merchant',
      linkWords,
      stateWords: stateWords(o, events, caseOpen),
      active,
      nextDue:
        active && due.length
          ? due.reduce((a, e) => (Date.parse(e.start) < Date.parse(a) ? e.start : a), due[0]!.start)
          : null,
      events: events.map((e) => ({ ...e, name: eventName(e, orderRef, linkWords) })),
    });
  }
  const last = (r: ScheduleRow) => Math.max(...r.events.map((e) => Date.parse(e.end ?? e.start)));
  rows.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    if (a.active)
      return (
        (a.nextDue ? Date.parse(a.nextDue) : Infinity) - (b.nextDue ? Date.parse(b.nextDue) : Infinity) ||
        a.orderId.localeCompare(b.orderId)
      );
    return last(b) - last(a) || a.orderId.localeCompare(b.orderId);
  });

  // The range drawn: every event and now, from the start of the first day to the end of the last, a day either side.
  const times = rows.flatMap((r) =>
    r.events.flatMap((e) => [Date.parse(e.start), Date.parse(e.end ?? e.start)]),
  );
  const lo = Math.min(t, ...times);
  const hi = Math.max(t + SHOWN_AHEAD_DAYS * DAY_MS, ...times);
  const floorDay = (ms: number) => ms - (ms % DAY_MS);
  return {
    now: now.toISOString(),
    start: iso(floorDay(lo) - DAY_MS),
    end: iso(floorDay(hi) + 2 * DAY_MS),
    rows,
  };
}

/** "Monday 9 November, 2:24 pm UTC", or a span "… to …". */
export function whenWords(e: Pick<ScheduleEvent, 'start' | 'end'>): string {
  return e.end ? `${spokenWhen(e.start)} to ${spokenWhen(e.end)}` : spokenWhen(e.start);
}

/** The full name of a bar or diamond: its kind, label and status, when, what it means, and where Enter goes. */
function eventName(e: ScheduleEvent, orderRef: string, linkWords: string): string {
  const go = linkWords.charAt(0).toLowerCase() + linkWords.slice(1);
  return `${e.toneWords}: ${e.label}, ${e.statusWords.toLowerCase()}. ${e.when}. ${e.detail} Order ${orderRef}. Press Enter to ${go}.`;
}
