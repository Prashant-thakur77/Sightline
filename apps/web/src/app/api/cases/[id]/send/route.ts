import { NextResponse } from 'next/server';
import { sendMoneyBack } from '@/server/cases';
import { HttpError, requireUser } from '@/server/session';
import { PayPalNotConfiguredError } from '@/server/paypal';
import { scheduleStoreAgent } from '@/server/store-agent';

export const runtime = 'nodejs';

/** The buyer confirmed the summary: void the hold, or send the case to the seller. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const sent = await sendMoneyBack(user.id, id);
    // The store's agent reads the case after this answer is sent, so the buyer never waits for it.
    if (sent.stage === 'seller_contacted') scheduleStoreAgent(id, { kind: 'case_received' });
    return NextResponse.json(sent);
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    if (e instanceof PayPalNotConfiguredError) return NextResponse.json({ error: "PayPal isn't connected yet, so nothing was sent." }, { status: 503 });
    console.error('[case-send]', e);
    return NextResponse.json({ error: 'PayPal did not accept that just now. Nothing changed. Try again in a minute.' }, { status: 502 });
  }
}
