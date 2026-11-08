import { NextResponse } from 'next/server';
import { z } from 'zod';
import { answerHelper } from '@/server/helper';

const Body = z.object({ answer: z.enum(['matches', 'different', 'cant_tell']), note: z.string().max(500).default('') });

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const body = Body.safeParse(await req.json().catch(() => ({})));
  if (!body.success) return NextResponse.json({ error: 'Please choose an answer.' }, { status: 400 });
  try {
    return NextResponse.json(await answerHelper(decodeURIComponent(token), body.data.answer, body.data.note));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 410 });
  }
}
