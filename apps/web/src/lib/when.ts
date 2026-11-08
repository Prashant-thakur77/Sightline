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
