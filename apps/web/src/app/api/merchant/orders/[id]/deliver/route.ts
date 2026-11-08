import { NextResponse } from 'next/server';
import { assertOrderInScope, assertSameOrigin, markDelivered, merchantFailure, requireMerchantScope } from '@/server/merchant';

export const runtime = 'nodejs';

/** Demo control: the carrier delivered the parcel. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(req);
    const scope = await requireMerchantScope();
    const { id } = await ctx.params;
    await assertOrderInScope(id, scope);
    return NextResponse.json(await markDelivered(id));
  } catch (e) {
    const f = merchantFailure(e, 'deliver');
    return NextResponse.json(f.body, { status: f.status });
  }
}
