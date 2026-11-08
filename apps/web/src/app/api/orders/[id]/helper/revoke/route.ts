import { NextResponse } from 'next/server';
import { revokeHelperLinks } from '@/server/helper';
import { HttpError, requireUser } from '@/server/session';

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    return NextResponse.json({ revoked: await revokeHelperLinks(user.id, id) });
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
