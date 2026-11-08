import { NextResponse } from 'next/server';
import {
  assertSameOrigin,
  assertOrderInScope,
  requireMerchantScope,
  merchantFailure,
  shipOrder,
  SHIP_CHOICES,
  MerchantError,
  type ShipChoice,
} from '@/server/merchant';

export const runtime = 'nodejs';

/** Demo control: ship the right item, a wrong one, a damaged one, or nothing. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(req);
    const scope = await requireMerchantScope();
    const { id } = await ctx.params;
    await assertOrderInScope(id, scope);
    const body = (await req.json().catch(() => ({}))) as { variant?: string };
    if (!SHIP_CHOICES.includes(body.variant as ShipChoice))
      throw new MerchantError(400, 'Choose what to ship.');
    return NextResponse.json(await shipOrder(id, body.variant as ShipChoice));
  } catch (e) {
    const f = merchantFailure(e, 'ship');
    return NextResponse.json(f.body, { status: f.status });
  }
}
