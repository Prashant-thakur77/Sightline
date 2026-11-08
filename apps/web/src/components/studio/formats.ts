import { formatMoney } from '@sightline/core';

/*
 * Value formatters shared by the dashboards and the sentences read out above them, so a figure is
 * written the same way in both places.
 */

/** Integer cents as dollars: 7344 -> "$73.44". Averages of cents are rounded to the nearest cent. */
export function centsText(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return '–';
  return formatMoney({ cents: Math.round(cents), currency: 'USD' });
}

/** "2 hours 5 minutes", "3 days 4 hours", "under a minute". */
export function durationText(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'under a minute';
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  const part = (n: number, w: string) => (n ? `${n} ${w}${n === 1 ? '' : 's'}` : '');
  return (d ? [part(d, 'day'), part(h, 'hour')] : [part(h, 'hour'), part(m, 'minute')]).filter(Boolean).join(' ');
}

export function hoursText(hours: number | null | undefined): string {
  if (hours === null || hours === undefined || !Number.isFinite(hours)) return 'None yet';
  return durationText(Math.round(hours * 3_600_000));
}

export function percentText(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '–';
  return `${Math.round(ratio * 100)}%`;
}

export function msText(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return 'not recorded';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}
