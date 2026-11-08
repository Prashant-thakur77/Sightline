import { NextResponse, type NextRequest } from 'next/server';

/**
 * Cross-site request protection for state-changing API calls, on top of SameSite=Lax session
 * cookies: a POST/PUT/PATCH/DELETE must come from our own origin. PayPal webhooks and the MCP
 * endpoint are exempt (they authenticate differently).
 */
/** Per-IP request budgets for routes that cost money (model calls, PayPal) or create state. */
const LIMITS: [RegExp, number][] = [
  [/^\/api\/judge\/run/, 4],
  [/^\/api\/demo\/start/, 30],
  [/^\/api\/orders\/[^/]+\/(check|money-back|helper)/, 12],
  [/^\/api\/cases\//, 12],
  [/^\/api\/studio\//, 20],
  [/^\/api\/turn/, 40],
  [/^\/api\/merchant\//, 40],
];
const WINDOW_MS = 60_000;
const hits = new Map<string, number[]>();

function rateLimited(ip: string, path: string): boolean {
  if (process.env.RATE_LIMITS === 'off') return false;
  const rule = LIMITS.find(([re]) => re.test(path));
  if (!rule) return false;
  const key = `${ip}|${rule[0].source}`;
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) for (const [k, v] of hits) if (now - (v[v.length - 1] ?? 0) > WINDOW_MS) hits.delete(k);
  return recent.length > rule[1];
}

export function proxy(req: NextRequest) {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return NextResponse.next();
  const path = req.nextUrl.pathname;
  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0]?.trim() || req.headers.get('x-real-ip') || 'local';
  if (path.startsWith('/api/') && !path.startsWith('/api/webhooks/') && rateLimited(ip, path))
    return NextResponse.json({ error: 'Too many requests. Please wait a minute and try again. Nothing was charged.' }, { status: 429, headers: { 'retry-after': '60' } });
  if (!path.startsWith('/api/') || path.startsWith('/api/webhooks/')) return NextResponse.next();
  const origin = req.headers.get('origin');
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  if (!origin) {
    // Same-origin fetches from browsers send Origin on POST; non-browser clients (tests, curl)
    // must send a JSON content type, which a cross-site form cannot.
    const ct = req.headers.get('content-type') ?? '';
    if (ct.includes('application/json') || ct.includes('multipart/form-data') || ct === '') return NextResponse.next();
    return NextResponse.json({ error: 'Cross-site request refused' }, { status: 403 });
  }
  try {
    if (new URL(origin).host === host) return NextResponse.next();
  } catch {
    /* fall through */
  }
  return NextResponse.json({ error: 'Cross-site request refused' }, { status: 403 });
}

export const config = { matcher: ['/api/:path*'] };
