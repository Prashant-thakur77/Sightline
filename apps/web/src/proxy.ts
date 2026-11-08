import { NextResponse, type NextRequest } from 'next/server';

/**
 * Cross-site request protection for state-changing API calls, on top of SameSite=Lax session
 * cookies: a POST/PUT/PATCH/DELETE must come from our own origin. PayPal webhooks and the MCP
 * endpoint are exempt (they authenticate differently).
 */
export function proxy(req: NextRequest) {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return NextResponse.next();
  const path = req.nextUrl.pathname;
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
