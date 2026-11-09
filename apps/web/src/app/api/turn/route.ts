import { NextResponse } from 'next/server';
import { z } from 'zod';
import { handleTurn } from '@/server/conductor';
import { HttpError, requireUser } from '@/server/session';

export const runtime = 'nodejs';
export const maxDuration = 60;

const Req = z.union([
  z.object({ text: z.string().min(1).max(500), source: z.enum(['voice', 'keyboard']) }),
  z.object({ action: z.enum(['choose', 'details', 'buy']), index: z.number().int().min(1).max(3) }),
  z.object({ action: z.enum(['confirm-button', 'hold']), readbackId: z.string().min(1) }),
  z.object({ action: z.literal('paypal-approved'), readbackId: z.string().min(1), paypalOrderId: z.string().min(1) }),
  z.object({ action: z.enum(['offer-accept', 'offer-decline']), offerId: z.string().min(1).max(100) }),
  z.object({ action: z.enum(['cancel', 'repeat', 'start', 'offer']) }),
]);

export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const body = Req.safeParse(await req.json());
    if (!body.success) return NextResponse.json({ error: 'Bad request' }, { status: 400 });
    return NextResponse.json(await handleTurn(user.id, body.data as never));
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    console.error('[turn]', e);
    return NextResponse.json({ error: 'Something went wrong. Nothing was charged.' }, { status: 500 });
  }
}
