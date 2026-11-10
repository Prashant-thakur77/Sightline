/**
 * Dates in spoken and written English, resolved against a clock the caller passes in.
 *
 * Each expression becomes a span of UTC days [from, to]. A named day ("Friday", "Nov 14",
 * "the 14th", "tomorrow", "in 3 days") is a single day; "next week", "this weekend", "within 5
 * days" are ranges. "by <day>" names that day; "before <day>" is every day up to the one before.
 *
 * Rules, so a reading never depends on guesswork:
 *   - weekday alone or "this <weekday>": its next occurrence, today included
 *   - "next <weekday>": that weekday in the following calendar week (weeks start on Monday)
 *   - "Nov 14" with no year: this year, unless that is more than 60 days ago, then next year
 *   - "the 14th" with no month: this month if the 14th is today or later, else next month
 *   - "in 3 days" is the third day from today; "in 3 business days" skips Saturday and Sunday
 *   - a weekday that disagrees with the date next to it ("Monday 17 November" when the 17th is a
 *     Tuesday) is marked as a conflict and is never supported
 */
import { addBusinessDays } from '@sightline/core';
import { readNumber } from './numbers';

const DAY_MS = 86_400_000;

/** Whole UTC days since the epoch. */
export function dayNumber(d: Date): number {
  return Math.floor(d.getTime() / DAY_MS);
}

/** "2026-11-17" */
export function dayLabel(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

export interface DateSpan {
  /** Word indices of the expression, end exclusive. */
  start: number;
  end: number;
  from: number;
  to: number;
  /** A weekday and a date that disagree. */
  conflict: boolean;
  /** Needs a clock and delivery context: "tomorrow", "next week", "in 3 days". */
  relative: boolean;
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS: Record<string, number> = {
  january: 0,
  jan: 0,
  february: 1,
  feb: 1,
  march: 2,
  mar: 2,
  april: 3,
  apr: 3,
  may: 4,
  june: 5,
  jun: 5,
  july: 6,
  jul: 6,
  august: 7,
  aug: 7,
  september: 8,
  sept: 8,
  sep: 8,
  october: 9,
  oct: 9,
  november: 10,
  nov: 10,
  december: 11,
  dec: 11,
};
const ORDINAL_WORDS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
  eleventh: 11,
  twelfth: 12,
  thirteenth: 13,
  fourteenth: 14,
  fifteenth: 15,
  sixteenth: 16,
  seventeenth: 17,
  eighteenth: 18,
  nineteenth: 19,
  twentieth: 20,
  thirtieth: 30,
};

/** Words that make "tomorrow" or "in 3 days" a delivery date rather than, say, a return window. */
const DELIVERY_WORDS = /\b(arriv\w*|deliver\w*|ship\w*|dispatch\w*|reach\w*|land\w*|due|expect\w*|get it|have it|get them|have them|with you|there)\b/;
const RETURN_WORDS = /\b(return\w*|refund\w*|exchang\w*|warrant\w*|guarantee\w*)\b/;

/** True when relative dates in this text should be read as delivery dates. */
export function deliveryContext(normalisedText: string): boolean {
  return DELIVERY_WORDS.test(normalisedText) && !RETURN_WORDS.test(normalisedText);
}

interface Read {
  value: number;
  end: number;
}

/** "17th", "17", "seventeenth", "twenty first", "thirty-first" (as split words). */
function readDay(ws: string[], i: number, allowBare: boolean): (Read & { ordinal: boolean }) | null {
  const w = ws[i];
  if (w === undefined) return null;
  const m = /^(\d{1,2})(st|nd|rd|th)?$/.exec(w);
  if (m) {
    const v = Number(m[1]);
    if (v < 1 || v > 31) return null;
    if (!m[2] && !allowBare) return null;
    return { value: v, end: i + 1, ordinal: Boolean(m[2]) };
  }
  if ((w === 'twenty' || w === 'thirty') && ws[i + 1] !== undefined) {
    const unit = ORDINAL_WORDS[ws[i + 1]!];
    if (unit !== undefined && unit < 10) {
      const v = (w === 'twenty' ? 20 : 30) + unit;
      if (v <= 31) return { value: v, end: i + 2, ordinal: true };
    }
  }
  const o = ORDINAL_WORDS[w];
  if (o !== undefined) return { value: o, end: i + 1, ordinal: true };
  return null;
}

function readYear(ws: string[], i: number): Read | null {
  const w = ws[i];
  if (w && /^20\d\d$/.test(w)) return { value: Number(w), end: i + 1 };
  return null;
}

function validDay(y: number, m: number, d: number): number | null {
  const t = Date.UTC(y, m, d);
  const back = new Date(t);
  if (back.getUTCMonth() !== m || back.getUTCDate() !== d) return null;
  return Math.floor(t / DAY_MS);
}

function monthDay(today: number, m: number, d: number, year?: number): number | null {
  if (year !== undefined) return validDay(year, m, d);
  const y = new Date(today * DAY_MS).getUTCFullYear();
  const here = validDay(y, m, d);
  if (here === null) return validDay(y + 1, m, d);
  return here < today - 60 ? validDay(y + 1, m, d) : here;
}

function dayOnly(today: number, d: number): number | null {
  const t = new Date(today * DAY_MS);
  const y = t.getUTCFullYear();
  const m = t.getUTCMonth();
  if (d >= t.getUTCDate()) {
    const here = validDay(y, m, d);
    if (here !== null) return here;
  }
  return validDay(m === 11 ? y + 1 : y, (m + 1) % 12, d);
}

const weekdayOf = (day: number) => new Date(day * DAY_MS).getUTCDay();

/** Monday of the week holding this day. */
function mondayOf(day: number): number {
  return day - ((weekdayOf(day) + 6) % 7);
}

/** "a", "an", "one", "a couple of", "a few", "3", "three". */
function readCount(ws: string[], i: number): { from: number; to: number; end: number } | null {
  const w = ws[i];
  if (w === 'a' || w === 'an') {
    if (ws[i + 1] === 'couple' && ws[i + 2] === 'of') return { from: 2, to: 2, end: i + 3 };
    if (ws[i + 1] === 'few') return { from: 2, to: 5, end: i + 2 };
    return { from: 1, to: 1, end: i + 1 };
  }
  if (w === 'few') return { from: 2, to: 5, end: i + 1 };
  const n = readNumber(ws, i);
  if (!n || !Number.isInteger(n.value) || n.value < 0 || n.value > 366) return null;
  return { from: n.value, to: n.value, end: n.end };
}

/** "days", "business days", "working days", "weeks". */
function readUnit(ws: string[], i: number): { kind: 'day' | 'business' | 'week'; end: number } | null {
  const w = ws[i];
  if (w === 'day' || w === 'days') return { kind: 'day', end: i + 1 };
  if (w === 'week' || w === 'weeks') return { kind: 'week', end: i + 1 };
  if ((w === 'business' || w === 'working') && (ws[i + 1] === 'day' || ws[i + 1] === 'days')) return { kind: 'business', end: i + 2 };
  return null;
}

function offset(today: number, n: number, unit: 'day' | 'business' | 'week'): number {
  if (unit === 'week') return today + 7 * n;
  if (unit === 'day') return today + n;
  return dayNumber(addBusinessDays(new Date(today * DAY_MS), n));
}

/**
 * Every date expression in a list of normalised words. `relative` turns on readings that only make
 * sense for a delivery ("tomorrow", "next week", "in 3 days").
 */
export function readDates(ws: string[], now: Date, relative: boolean): DateSpan[] {
  const today = dayNumber(now);
  const todayWd = weekdayOf(today);
  const thisMonday = mondayOf(today);
  const nextMonday = thisMonday + 7;
  const out: DateSpan[] = [];
  const span = (start: number, end: number, from: number, to: number, rel: boolean, conflict = false): DateSpan => ({ start, end, from, to, conflict, relative: rel });

  let i = 0;
  while (i < ws.length) {
    const found = readAt(i);
    if (found) {
      // "before Friday": every day up to the one before. "by next week": any day up to its end.
      const prev = ws[found.start - 1];
      if (prev === 'before' || prev === 'until' || prev === 'till') {
        found.to = found.from - 1;
        found.from = Math.min(today, found.to);
        found.start--;
      } else if (prev === 'by' && found.to > found.from) {
        found.from = Math.min(today, found.from);
        found.start--;
      }
      out.push(found);
      i = found.end;
    } else i++;
  }
  return out;

  function datedWeekday(i: number, wd: number, after: number): DateSpan | null {
    // "Tuesday 17 November", "Tuesday the 17th", "Tuesday, November 17", "Tuesday 17th".
    let j = after;
    if (ws[j] === 'the') j++;
    const dFirst = readDay(ws, j, true);
    if (dFirst) {
      let k = dFirst.end;
      if (ws[k] === 'of') k++;
      const m = MONTHS[ws[k] ?? ''];
      if (m !== undefined) {
        const y = readYear(ws, k + 1);
        const day = monthDay(today, m, dFirst.value, y?.value);
        if (day !== null) return span(i, y ? y.end : k + 1, day, day, false, weekdayOf(day) !== wd);
      }
      if (dFirst.ordinal || ws[after] === 'the') {
        const day = dayOnly(today, dFirst.value);
        if (day !== null) return span(i, dFirst.end, day, day, false, weekdayOf(day) !== wd);
      }
    }
    const m = MONTHS[ws[after] ?? ''];
    if (m !== undefined) {
      let k = after + 1;
      if (ws[k] === 'the') k++;
      const d = readDay(ws, k, true);
      if (d) {
        const y = readYear(ws, d.end);
        const day = monthDay(today, m, d.value, y?.value);
        if (day !== null) return span(i, y ? y.end : d.end, day, day, false, weekdayOf(day) !== wd);
      }
    }
    return null;
  }

  function readAt(i: number): DateSpan | null {
    const w = ws[i]!;

    // Weekdays, with "this" or "next" in front.
    const lead = w === 'this' || w === 'next' || w === 'coming' ? w : null;
    const wdWord = lead ? ws[i + 1] : w;
    const wd = WEEKDAYS.indexOf(wdWord ?? '');
    if (wd >= 0) {
      const at = lead ? i + 1 : i;
      const dated = datedWeekday(i, wd, at + 1);
      if (dated) return dated;
      const day = lead === 'next' ? nextMonday + ((wd + 6) % 7) : today + ((wd - todayWd + 7) % 7);
      return span(i, at + 1, day, day, false);
    }

    // "November 17", "Nov 17th, 2026", "November the seventeenth".
    const m = MONTHS[w];
    if (m !== undefined && !(w === 'may' && !readDay(ws, i + 1, true))) {
      let k = i + 1;
      if (ws[k] === 'the') k++;
      const d = readDay(ws, k, true);
      if (d) {
        const y = readYear(ws, d.end);
        const day = monthDay(today, m, d.value, y?.value);
        if (day !== null) return span(i, y ? y.end : d.end, day, day, false);
      }
    }

    // "17 November", "17th of Nov", "the 17th of November", "the 17th", "on the seventeenth".
    const theLead = w === 'the' ? 1 : 0;
    const d = readDay(ws, i + theLead, true);
    if (d) {
      let k = d.end;
      if (ws[k] === 'of') k++;
      const mm = MONTHS[ws[k] ?? ''];
      if (mm !== undefined && (mm !== 4 || ws[k] === 'may')) {
        const y = readYear(ws, k + 1);
        const day = monthDay(today, mm, d.value, y?.value);
        if (day !== null) return span(i, y ? y.end : k + 1, day, day, false);
      }
      const prev = ws[i - 1];
      const dayWord = theLead === 1 || prev === 'on' || prev === 'by' || prev === 'until' || prev === 'before';
      if (d.ordinal && dayWord && !/^(time|one|parcel|order|item|pair|size)s?$/.test(ws[d.end] ?? '')) {
        const day = dayOnly(today, d.value);
        if (day !== null) return span(i, d.end, day, day, false);
      }
    }

    if (!relative) return null;

    // "today", "tonight", "tomorrow", "the day after tomorrow".
    if (w === 'today' || w === 'tonight') return span(i, i + 1, today, today, true);
    if (w === 'tomorrow') return span(i, i + 1, today + 1, today + 1, true);
    if (w === 'day' && ws[i + 1] === 'after' && ws[i + 2] === 'tomorrow') return span(ws[i - 1] === 'the' ? i - 1 : i, i + 3, today + 2, today + 2, true);

    // "in 3 days", "within 2 weeks", "in three business days".
    if (w === 'in' || w === 'within') {
      const c = readCount(ws, i + 1);
      const u = c ? readUnit(ws, c.end) : null;
      if (c && u) {
        const end = ws[u.end] === 'time' ? u.end + 1 : u.end;
        if (w === 'within') return span(i, end, today, offset(today, c.to, u.kind), true);
        return span(i, end, offset(today, c.from, u.kind), offset(today, c.to, u.kind), true);
      }
    }
    // "3 days from now", "two business days from today".
    {
      const c = readCount(ws, i);
      const u = c ? readUnit(ws, c.end) : null;
      if (c && u && ws[u.end] === 'from' && (ws[u.end + 1] === 'now' || ws[u.end + 1] === 'today'))
        return span(i, u.end + 2, offset(today, c.from, u.kind), offset(today, c.to, u.kind), true);
    }

    // Weeks and weekends.
    const lead2 = w === 'early' || w === 'late' || w === 'later' ? w : null;
    const base = lead2 ? i + 1 : i;
    const which = ws[base];
    if ((which === 'this' || which === 'next') && ws[base + 1] === 'week') {
      const mon = which === 'this' ? thisMonday : nextMonday;
      const first = which === 'this' ? today : mon;
      if (lead2 === 'early') return span(i, base + 2, Math.max(first, mon), Math.max(first, mon + 2), true);
      if (lead2) return span(i, base + 2, Math.max(first, mon + 3), mon + 6, true);
      return span(i, base + 2, first, mon + 6, true);
    }
    if (w === 'end' && ws[i + 1] === 'of') {
      let k = i + 2;
      if (ws[k] === 'the' || ws[k] === 'this') k++;
      const next = ws[k] === 'next';
      if (next) k++;
      if (ws[k] === 'week') {
        const mon = next ? nextMonday : thisMonday;
        return span(ws[i - 1] === 'the' ? i - 1 : i, k + 1, Math.max(today, mon + 4), mon + 6, true);
      }
    }
    if (w === 'weekend' || ((w === 'this' || w === 'next' || w === 'the') && ws[i + 1] === 'weekend')) {
      const start = w === 'weekend' ? i : i;
      const end = w === 'weekend' ? i + 1 : i + 2;
      const sat = (w === 'next' ? nextMonday : thisMonday) + 5;
      const prev = ws[start - 1];
      if (w !== 'next' && (prev === 'by' || prev === 'before')) {
        // "by the weekend": any day up to Saturday; "before the weekend": up to Friday.
        return span(start - 1, end, today, prev === 'by' ? Math.max(today, sat) : Math.max(today, sat - 1), true);
      }
      return span(start, end, Math.max(today, sat), Math.max(today, sat + 1), true);
    }
    if ((w === 'this' || w === 'next') && ws[i + 1] === 'month') {
      const t = new Date(today * DAY_MS);
      const y = t.getUTCFullYear();
      const mo = t.getUTCMonth() + (w === 'next' ? 1 : 0);
      const first = Math.floor(Date.UTC(y, mo, 1) / DAY_MS);
      const last = Math.floor(Date.UTC(y, mo + 1, 1) / DAY_MS) - 1;
      return span(i, i + 2, Math.max(today, first), last, true);
    }
    return null;
  }
}
