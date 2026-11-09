import { NextResponse } from 'next/server';
import { z } from 'zod';
import { describePolicy, POLICY_MAX_CENTS } from '@sightline/agent';
import { assertSameOrigin, merchantFailure, MerchantError, requireMerchantScope } from '@/server/merchant';
import { loadStorePolicy, saveStorePolicy } from '@/server/store-policy';
import { audit } from '@/server/audit';

export const runtime = 'nodejs';

const cents = z.number().int().min(0).max(POLICY_MAX_CENTS);
const Patch = z
  .object({
    agentOn: z.boolean(),
    autoSend: z.boolean(),
    autoReplaceMaxCents: cents,
    askStaffAboveCents: cents,
    partialRefunds: z.enum(['none', 'up_to_20', 'up_to_50']),
  })
  .partial()
  .strict();

/** The store agent policy for this demo session's store, in plain words and as numbers. */
export async function GET() {
  try {
    const scope = await requireMerchantScope();
    const policy = await loadStorePolicy(scope);
    return NextResponse.json({ policy, words: describePolicy(policy) });
  } catch (e) {
    const f = merchantFailure(e, 'policy');
    return NextResponse.json(f.body, { status: f.status });
  }
}

/** Change part of the policy (amounts in whole cents). The Store agent page does the same with a form. */
export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    const scope = await requireMerchantScope();
    const parsed = Patch.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new MerchantError(400, 'That policy change was not understood. Nothing was saved.');
    const policy = { ...(await loadStorePolicy(scope)), ...parsed.data };
    await saveStorePolicy(scope, policy);
    await audit({ userId: scope, actor: 'merchant', action: 'store_policy.saved', subjectId: scope, payload: { ...policy } });
    return NextResponse.json({ ok: true, message: `Saved. ${describePolicy(policy)}`, policy });
  } catch (e) {
    const f = merchantFailure(e, 'policy');
    return NextResponse.json(f.body, { status: f.status });
  }
}
