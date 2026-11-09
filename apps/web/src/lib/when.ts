/**
 * "Nov 9, 2026, 3:04 PM UTC": the month in words and the time zone said out loud, so a date reads
 * the same on every page, in every locale, on the server and in the browser.
 */
export function utcWhen(iso: string | Date | null | undefined): string {
  if (!iso) return 'date unknown';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'date unknown';
  return `${d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC`;
}

/**
 * "Sunday 8 November, 11:40 pm UTC": the way the app says a time aloud, for the buyer's own order
 * pages. Built from parts, so it reads the same in every locale, on the server and in the browser.
 */
export function spokenWhen(iso: string | Date | null | undefined): string {
  if (!iso) return 'date unknown';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'date unknown';
  const part = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { ...o, timeZone: 'UTC' }).format(d);
  const h = d.getUTCHours();
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  return `${part({ weekday: 'long' })} ${part({ day: 'numeric' })} ${part({ month: 'long' })}, ${h % 12 || 12}:${m} ${h < 12 ? 'am' : 'pm'} UTC`;
}
