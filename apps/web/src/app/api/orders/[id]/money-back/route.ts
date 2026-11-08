import { NextResponse } from 'next/server';
import { prepareMoneyBack } from '@/server/cases';
import { HttpError, requireUser } from '@/server/session';

export const runtime = 'nodejs';
export const maxDuration = 60;

/** Builds the evidence pack and a draft. Sends nothing. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    return NextResponse.json(await prepareMoneyBack(user.id, id));
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    if (e instanceof Error && e.message.startsWith('Money back needs')) return NextResponse.json({ error: e.message }, { status: 409 });
    console.error('[money-back]', e);
    return NextResponse.json({ error: 'I could not build the evidence just now. Nothing was sent.' }, { status: 500 });
  }
}
