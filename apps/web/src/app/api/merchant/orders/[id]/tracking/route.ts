import { NextResponse } from 'next/server';
import { assertSameOrigin, attachPendingTracking, merchantFailure } from '@/server/merchant';

export const runtime = 'nodejs';

/** Sends recorded tracking to PayPal once the order has a capture. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(req);
    const { id } = await ctx.params;
    return NextResponse.json(await attachPendingTracking(id));
  } catch (e) {
    const f = merchantFailure(e, 'tracking');
    return NextResponse.json(f.body, { status: f.status });
  }
}
