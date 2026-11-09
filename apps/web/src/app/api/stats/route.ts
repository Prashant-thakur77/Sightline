import { NextResponse } from 'next/server';
import { loadSuites } from '@/server/stats';

export const dynamic = 'force-dynamic';

/** Every headline number, read from the committed eval result files on each request. */
export async function GET() {
  return NextResponse.json({ suites: await loadSuites(), generatedAt: new Date().toISOString() });
}
