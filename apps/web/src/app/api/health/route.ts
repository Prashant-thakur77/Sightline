import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { db, INTEGRATIONS } from '@/server/runtime';

export const dynamic = 'force-dynamic';

export async function GET() {
  const database = await db()
    .execute(sql`select 1`)
    .then(() => true)
    .catch(() => false);
  return NextResponse.json({ ok: database, database, sandbox: true, integrations: INTEGRATIONS }, { status: database ? 200 : 503 });
}
