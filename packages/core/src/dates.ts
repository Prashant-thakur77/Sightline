/** "Tuesday 17 November" — the way the readback says dates. */
export function spokenDate(iso: string | Date, locale = 'en-US', timeZone = 'UTC'): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  const weekday = new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone }).format(d);
  const day = new Intl.DateTimeFormat(locale, { day: 'numeric', timeZone }).format(d);
  const month = new Intl.DateTimeFormat(locale, { month: 'long', timeZone }).format(d);
  return `${weekday} ${day} ${month}`;
}

export function addDays(d: Date, days: number): Date {
  const out = new Date(d.getTime());
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

/** Add business days (Mon-Fri) for delivery estimates. */
export function addBusinessDays(d: Date, days: number): Date {
  let out = new Date(d.getTime());
  let left = days;
  while (left > 0) {
    out = addDays(out, 1);
    const wd = out.getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return out;
}
