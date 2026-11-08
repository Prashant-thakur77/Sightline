import { NextResponse } from 'next/server';
import {
  assertSameOrigin,
  CASE_ACTIONS,
  MerchantError,
  merchantFailure,
  respondToCase,
  type CaseAction,
} from '@/server/merchant';

export const runtime = 'nodejs';
export const maxDuration = 60;

/** The merchant's confirmed reply to a case. Requires `confirm: true`; nothing runs on its own. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(req);
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as { action?: string; confirm?: boolean };
    if (!CASE_ACTIONS.includes(body.action as CaseAction)) throw new MerchantError(400, 'Choose a reply.');
    if (body.confirm !== true) throw new MerchantError(400, 'Confirm the reply first. Nothing was sent.');
    return NextResponse.json(await respondToCase(id, body.action as CaseAction));
  } catch (e) {
    const f = merchantFailure(e, 'respond');
    return NextResponse.json(f.body, { status: f.status });
  }
}
