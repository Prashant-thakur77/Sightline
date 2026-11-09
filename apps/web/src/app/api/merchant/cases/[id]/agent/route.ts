import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { tables } from '@sightline/db';
import { assertCaseInScope, assertSameOrigin, MerchantError, merchantFailure, requireMerchantScope } from '@/server/merchant';
import { dismissProposal, runStoreAgent, sendProposal, type StoreAgentRun } from '@/server/store-agent';
import { db } from '@/server/runtime';

export const runtime = 'nodejs';
export const maxDuration = 120;

const DOS = ['ask', 'send', 'change', 'dismiss'] as const;
type Do = (typeof DOS)[number];

/** What staff see after acting on the store agent's proposal. */
function answer(run: StoreAgentRun, did: Do): { ok: boolean; message: string; paypal: string } {
  const ok = run.kind === 'sent' || run.kind === 'waiting' || (did === 'dismiss' && run.kind === 'skipped' && Boolean(run.proposalId));
  const message =
    did === 'ask' && run.kind === 'waiting'
      ? `Your store agent proposes: ${run.title}. It waits for you: ${run.message}`
      : did === 'ask' && run.kind === 'sent'
        ? `Your store agent sent: ${run.title}. ${run.message}`
        : run.message;
  return { ok, message, paypal: run.result?.paypal ?? 'not-needed' };
}

/**
 * Staff and the store's agent on one case: ask the agent to read it now, or Send, Change or
 * Dismiss what it proposed. Send and Change need `confirm: true`; the amount and whether the reply
 * is allowed are decided again by code when it is sent.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(req);
    const scope = await requireMerchantScope();
    const { id } = await ctx.params;
    await assertCaseInScope(id, scope);
    const body = (await req.json().catch(() => ({}))) as { do?: string; proposalId?: string; optionId?: string; confirm?: boolean };
    const did = body.do as Do;
    if (!DOS.includes(did)) throw new MerchantError(400, 'Choose what to do with the proposal.');
    if (did === 'ask') return NextResponse.json(answer(await runStoreAgent(id, { kind: 'staff_asked' }), did));
    if (!body.proposalId) throw new MerchantError(400, 'That proposal was not found.');
    const [p] = await db().select({ caseId: tables.storeAgentProposals.caseId }).from(tables.storeAgentProposals).where(eq(tables.storeAgentProposals.id, body.proposalId)).limit(1);
    if (!p || p.caseId !== id) throw new MerchantError(404, 'That proposal was not found.');
    if (did === 'dismiss') return NextResponse.json(answer(await dismissProposal(body.proposalId), did));
    if (body.confirm !== true) throw new MerchantError(400, 'Confirm the reply first. Nothing was sent.');
    if (did === 'change' && !body.optionId) throw new MerchantError(400, 'Choose a reply first. Nothing was sent.');
    return NextResponse.json(answer(await sendProposal(body.proposalId, 'staff', did === 'change' ? { optionId: body.optionId } : {}), did));
  } catch (e) {
    const f = merchantFailure(e, 'agent');
    return NextResponse.json(f.body, { status: f.status });
  }
}
