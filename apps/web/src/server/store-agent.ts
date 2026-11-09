import 'server-only';
import { after } from 'next/server';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { tables } from '@sightline/db';
import { newId } from '@sightline/core';
import { buildStoreAgentPrompt, checkProposal, rulesProposal, type CheckedProposal, type StoreOption } from '@sightline/agent';
import { db } from './runtime';
import { audit } from './audit';
import { aiAvailable, claudeStoreAgent, type StoreAgentModel } from './ai';
import { AWAITING_STORE, loadStoreCase, type StoreCase } from './store-case';
import { newId as freshId } from '@sightline/core';
import { offerPartialRefund, respondToCase, type CaseReplyMeta, type MerchantResult } from './merchant';

/*
 * The store's own agent. When a money-back case reaches the store, or the buyer declines an offer,
 * it reads the signed evidence pack (checked first), the order, the store's shipping record and the
 * store's policy, and proposes one reply. Code lists the replies and their amounts; the model only
 * picks one and gives reasons, and each reason is checked against the facts it cites. Inside the
 * policy the reply is sent at once, through the same functions store staff use; otherwise it waits
 * on the cases desk for Send, Change or Dismiss. After one revised proposal it hands the case to
 * staff. Every step is in the audit chain as store_agent.step.
 */

export type StoreAgentTrigger =
  | { kind: 'case_received' }
  | { kind: 'offer_declined'; offerId: string }
  | { kind: 'staff_asked' }
  /** The maintenance job, after a run that died part way. */
  | { kind: 'retry' };

export interface StoreAgentRun {
  kind: 'sent' | 'waiting' | 'handed_over' | 'skipped' | 'failed';
  message: string;
  proposalId?: string;
  title?: string;
  reasons?: string[];
  source?: 'model' | 'rules';
  /** For a sent reply: what the store's reply path answered. */
  result?: MerchantResult;
}

type Proposal = typeof tables.storeAgentProposals.$inferSelect;

/** At most this many proposals per case: the first, and one revision after a decline. */
export const MAX_PROPOSALS = 2;
/** A claim older than this with no answer is from a run that died; it no longer blocks the case. */
export const THINKING_STALE_MS = 5 * 60_000;

const step = (userId: string, orderId: string, payload: { tool: string | null; step: string; summary: string } & Record<string, unknown>) =>
  audit({ userId, actor: 'store_agent', action: 'store_agent.step', subjectId: orderId, payload });

/** The PayPal API a reply goes through, for the timeline. Offers move no money until they are accepted. */
function toolFor(o: StoreOption, sc: StoreCase): string | null {
  if (sc.facts.dispute) return 'PayPal Disputes API';
  return o.resolution === 'refund' ? 'PayPal Payments API' : null;
}

async function claim(caseId: string, triggerRef: string, round: number, status: 'thinking' | 'handed_over', result?: string): Promise<string | null> {
  const id = newId('sap');
  const rows = await db()
    .insert(tables.storeAgentProposals)
    .values({ id, caseId, triggerRef, round, status, result: result ?? null, ...(status === 'handed_over' ? { decidedBy: 'store_agent', decidedAt: new Date().toISOString() } : {}) })
    .onConflictDoNothing()
    .returning({ id: tables.storeAgentProposals.id });
  return rows[0]?.id ?? null;
}

async function handOver(sc: StoreCase, proposalId: string, why: string): Promise<StoreAgentRun> {
  await db()
    .update(tables.storeAgentProposals)
    .set({ status: 'handed_over', result: why, decidedBy: 'store_agent', decidedAt: new Date().toISOString() })
    .where(eq(tables.storeAgentProposals.id, proposalId));
  await step(sc.order.userId, sc.order.id, { tool: null, step: 'handed_over', summary: why, caseId: sc.kase.id });
  return { kind: 'handed_over', message: why, proposalId };
}

/**
 * Look at one case and propose a reply. Safe to call more than once for the same trigger: the
 * proposal row is claimed first, so a repeated trigger finds it and does nothing.
 */
export async function runStoreAgent(caseId: string, trigger: StoreAgentTrigger, deps: { model?: StoreAgentModel | null } = {}): Promise<StoreAgentRun> {
  const [kase] = await db().select().from(tables.cases).where(eq(tables.cases.id, caseId)).limit(1);
  if (!kase) return { kind: 'skipped', message: 'That case was not found.' };
  if (!AWAITING_STORE.has(kase.stage)) return { kind: 'skipped', message: 'The case is not waiting for the store.' };
  const existing = await db().select().from(tables.storeAgentProposals).where(eq(tables.storeAgentProposals.caseId, caseId)).orderBy(asc(tables.storeAgentProposals.createdAt));
  // A run that died part way (a restart) leaves a claim behind: after a few minutes it no longer blocks.
  const stale = existing.filter((p) => p.status === 'thinking' && Date.now() - Date.parse(p.createdAt) > THINKING_STALE_MS);
  if (stale.length)
    await db()
      .update(tables.storeAgentProposals)
      .set({ status: 'failed', result: 'The store agent stopped part way. Staff can reply as usual.' })
      .where(inArray(tables.storeAgentProposals.id, stale.map((p) => p.id)));
  // A reply being sent blocks too: its outcome is not known yet.
  if (existing.some((p) => (p.status === 'thinking' && !stale.includes(p)) || p.status === 'proposed' || p.status === 'sending'))
    return { kind: 'skipped', message: 'A proposal is already waiting.' };
  if (existing.some((p) => p.status === 'handed_over')) return { kind: 'skipped', message: 'The store agent already handed this case to staff.' };
  const made = existing.filter((p) => p.round > 0 && p.status !== 'failed' && !stale.includes(p)).length;
  if (trigger.kind === 'case_received' && made > 0) return { kind: 'skipped', message: 'The store agent already looked at this case.' };
  // The case and each declined offer are claimed once; staff asks and retries are new triggers each time.
  // A second proposal for the same round is refused by the database (unique round per case).
  const triggerRef = trigger.kind === 'case_received' ? 'case' : trigger.kind === 'offer_declined' ? trigger.offerId : `${trigger.kind}-${freshId('trg')}`;

  const [order] = await db().select().from(tables.orders).where(eq(tables.orders.id, kase.orderId)).limit(1);
  if (!order) return { kind: 'skipped', message: 'The order for this case was not found.' };
  if (made >= MAX_PROPOSALS) {
    const why = 'The revised offer was declined too, so the store agent handed the case to store staff.';
    const id = await claim(caseId, triggerRef, 0, 'handed_over', why);
    if (!id) return { kind: 'skipped', message: 'Already handled.' };
    await step(order.userId, order.id, { tool: null, step: 'handed_over', summary: why, caseId });
    return { kind: 'handed_over', message: why, proposalId: id };
  }

  const round = made + 1;
  const sc = await loadStoreCase(caseId, round);
  if (!sc) return { kind: 'skipped', message: 'The case could not be read.' };
  if (!sc.policy.agentOn) return { kind: 'skipped', message: 'The store agent is off in the store policy.' };
  const proposalId = await claim(caseId, triggerRef, round, 'thinking');
  if (!proposalId) return { kind: 'skipped', message: 'Already handled.' };

  try {
    // 1. The evidence, checked before anything is said about it.
    if (!sc.pack.verified)
      return await handOver(sc, proposalId, 'The signed evidence pack did not verify, so the store agent stopped and handed the case to staff.');
    const v = sc.facts.verdict;
    await step(order.userId, order.id, {
      tool: 'Sightline evidence check',
      step: 'read_evidence',
      summary: `Read the signed evidence pack. Its fingerprint and signature check out${v ? `, and the check inside says the item ${v.kind === 'mismatch' ? 'does not match' : v.kind === 'unsure' ? 'may not match' : 'matches'}` : ''}.`,
      caseId,
    });
    if (!sc.options.length) return await handOver(sc, proposalId, 'No reply is left that the store policy allows, so the store agent handed the case to staff.');

    // 2. The choice: the model picks among the options code allows, or the store's rules do.
    const notes: { text: string; why: string }[] = [];
    let picked: CheckedProposal | null = null;
    let source: 'model' | 'rules' = 'rules';
    let modelName: string | null = null;
    const model = deps.model === undefined ? (aiAvailable() ? claudeStoreAgent : null) : deps.model;
    if (model) {
      try {
        const { system, prompt } = buildStoreAgentPrompt(sc.facts, sc.factList, sc.options);
        const answer = await model({ system, prompt, optionIds: sc.options.map((o) => o.id), factIds: sc.factList.map((f) => f.id) });
        modelName = answer.model;
        const checked = checkProposal(answer.raw, sc.factList, sc.options, { held: sc.facts.payment === 'held' && !sc.facts.dispute });
        if (checked.ok) {
          picked = checked;
          source = 'model';
          notes.push(...checked.dropped);
        } else notes.push(...checked.dropped, { text: '', why: `Claude’s answer was set aside (${checked.why}), so the store rules decided.` });
      } catch (e) {
        console.error('[store-agent] model call failed', e);
        notes.push({ text: '', why: 'Claude did not answer, so the store rules decided.' });
      }
    } else notes.push({ text: '', why: 'Claude is not connected on this server, so the store rules decided.' });
    picked ??= rulesProposal(sc.facts, sc.factList, sc.options);
    if (!picked) return await handOver(sc, proposalId, 'No reply is left that the store policy allows, so the store agent handed the case to staff.');

    const o = picked.option;
    // Only if the claim is still ours: a staff reply meanwhile supersedes it, and then the agent stops.
    const kept = await db()
      .update(tables.storeAgentProposals)
      .set({
        status: 'proposed',
        optionId: o.id,
        resolution: o.resolution,
        percent: o.percent,
        amountCents: o.amountCents,
        title: o.title,
        reasons: picked.reasons,
        staffNote: picked.staffNote,
        source,
        model: modelName,
        auto: o.auto,
        staffWhy: o.staffWhy,
        checkNotes: notes,
        policy: sc.policy,
      })
      .where(and(eq(tables.storeAgentProposals.id, proposalId), eq(tables.storeAgentProposals.status, 'thinking')))
      .returning({ id: tables.storeAgentProposals.id });
    if (!kept.length) return { kind: 'skipped', message: 'Store staff replied while the agent was reading the case.', proposalId };
    await step(order.userId, order.id, {
      tool: source === 'model' ? 'Claude' : 'Store rules',
      step: 'proposed',
      summary: `Proposed: ${o.title}. ${picked.reasons[0] ?? ''}`.trim(),
      caseId,
      proposalId,
      optionId: o.id,
      amountCents: o.amountCents,
      decided: source,
      ...(source === 'rules' && notes.length ? { why: notes[notes.length - 1]!.why } : {}),
    });

    // 3. Inside the policy it goes out now, through the store's own reply paths; otherwise staff decide.
    if (!o.auto) {
      // The summary is read on the buyer's timeline too, so the store-facing reason stays in the payload.
      await step(order.userId, order.id, {
        tool: null,
        step: 'waiting_for_staff',
        summary: 'Left it for store staff to approve, because it is outside what the store lets its agent send alone.',
        caseId,
        proposalId,
        staffWhy: o.staffWhy,
        decided: 'rules',
      });
      return { kind: 'waiting', message: o.staffWhy ?? 'Waiting for staff.', proposalId, title: o.title, reasons: picked.reasons, source };
    }
    const sent = await sendProposal(proposalId, 'store_agent');
    return { ...sent, title: o.title, reasons: picked.reasons, source };
  } catch (e) {
    console.error('[store-agent] run failed', e);
    await db()
      .update(tables.storeAgentProposals)
      .set({ status: 'failed', result: 'Something went wrong while reading the case. Staff can reply as usual.' })
      .where(and(eq(tables.storeAgentProposals.id, proposalId), eq(tables.storeAgentProposals.status, 'thinking')));
    return { kind: 'failed', message: 'Something went wrong while reading the case. Staff can reply as usual.', proposalId };
  }
}

/**
 * Send a proposal: by the agent (only inside the policy, decided again by code now) or by staff
 * (Send, or Change to another allowed reply). The amount is recomputed from the order and must
 * equal the proposal's. Money moves only through respondToCase and offerPartialRefund.
 */
export async function sendProposal(proposalId: string, by: 'store_agent' | 'staff', opts: { optionId?: string } = {}): Promise<StoreAgentRun> {
  const [p] = await db().select().from(tables.storeAgentProposals).where(eq(tables.storeAgentProposals.id, proposalId)).limit(1);
  if (!p || p.status !== 'proposed') return { kind: 'skipped', message: 'That proposal is no longer waiting.' };
  const sc = await loadStoreCase(p.caseId, p.round);
  if (!sc || !AWAITING_STORE.has(sc.kase.stage)) {
    await settle(p, 'superseded', 'The case moved on before this was sent.', by);
    return { kind: 'skipped', message: 'The case moved on before this was sent. Nothing was sent.' };
  }
  const changed = Boolean(opts.optionId && opts.optionId !== p.optionId);
  const option = sc.options.find((o) => o.id === (opts.optionId ?? p.optionId));
  if (!option) return { kind: 'failed', message: 'That reply is not allowed on this case any more. Nothing was sent.' };
  if (!changed && option.amountCents !== p.amountCents) return { kind: 'failed', message: 'The amount no longer matches the order. Nothing was sent. Ask the store agent again.' };
  if (by === 'store_agent' && !option.auto) return { kind: 'waiting', message: option.staffWhy ?? 'This reply needs staff.', proposalId };
  // Claimed before anything is sent, so two clicks (or the agent and a person) can't both send it.
  const claimed = await db()
    .update(tables.storeAgentProposals)
    .set({ status: 'sending' })
    .where(and(eq(tables.storeAgentProposals.id, p.id), eq(tables.storeAgentProposals.status, 'proposed')))
    .returning({ id: tables.storeAgentProposals.id });
  if (!claimed.length) return { kind: 'skipped', message: 'That proposal is already being handled.' };

  const meta: CaseReplyMeta = { by, proposalId: p.id, reasons: changed ? [] : (p.reasons ?? []), expectStages: [...AWAITING_STORE] };
  let result: MerchantResult;
  try {
    result =
      option.resolution === 'partial_refund'
        ? await offerPartialRefund(p.caseId, { percent: option.percent!, amountCents: option.amountCents! }, meta)
        : await respondToCase(p.caseId, option.resolution === 'refund' ? 'refund' : option.resolution === 'return' ? 'return' : 'replacement', meta);
  } catch (e) {
    result = { ok: false, paypal: 'not-needed', message: (e as Error).message || 'Nothing was sent.' };
  }
  const { order } = sc;
  if (!result.ok) {
    // Back on the desk for staff, with what went wrong.
    await db()
      .update(tables.storeAgentProposals)
      .set({ status: 'proposed', auto: false, result: result.message })
      .where(eq(tables.storeAgentProposals.id, p.id));
    if (by === 'store_agent')
      await step(order.userId, order.id, {
        tool: toolFor(option, sc),
        step: 'send_failed',
        summary: 'Could not send it just now, so it waits for store staff. Nothing changed.',
        caseId: p.caseId,
        proposalId: p.id,
        error: result.message,
      });
    return { kind: 'failed', message: result.message, proposalId: p.id, result };
  }
  await db()
    .update(tables.storeAgentProposals)
    .set({
      status: 'sent',
      result: result.message,
      decidedBy: by,
      decidedAt: new Date().toISOString(),
      ...(changed ? { optionId: option.id, resolution: option.resolution, percent: option.percent, amountCents: option.amountCents, title: `${option.title} (changed by staff)` } : {}),
    })
    .where(eq(tables.storeAgentProposals.id, p.id));
  if (by === 'store_agent')
    await step(order.userId, order.id, {
      tool: toolFor(option, sc),
      step: 'sent',
      summary: `Sent it without staff, because it is inside the store policy: ${option.title}.`,
      caseId: p.caseId,
      proposalId: p.id,
      decided: 'rules',
    });
  else
    await audit({
      userId: order.userId,
      actor: 'merchant',
      action: 'store_agent.proposal_sent',
      subjectId: order.id,
      payload: { caseId: p.caseId, proposalId: p.id, optionId: option.id, changed },
    });
  return { kind: 'sent', message: result.message, proposalId: p.id, result };
}

async function settle(p: Proposal, status: string, result: string, by: string) {
  await db()
    .update(tables.storeAgentProposals)
    .set({ status, result, decidedBy: by, decidedAt: new Date().toISOString() })
    .where(eq(tables.storeAgentProposals.id, p.id));
}

/** Staff set the proposal aside; the regular replies stay available. */
export async function dismissProposal(proposalId: string): Promise<StoreAgentRun> {
  const [p] = await db().select().from(tables.storeAgentProposals).where(eq(tables.storeAgentProposals.id, proposalId)).limit(1);
  if (!p || p.status !== 'proposed') return { kind: 'skipped', message: 'That proposal is no longer waiting.' };
  const done = await db()
    .update(tables.storeAgentProposals)
    .set({ status: 'dismissed', result: 'Store staff set it aside.', decidedBy: 'staff', decidedAt: new Date().toISOString() })
    .where(and(eq(tables.storeAgentProposals.id, p.id), eq(tables.storeAgentProposals.status, 'proposed')))
    .returning({ id: tables.storeAgentProposals.id });
  if (!done.length) return { kind: 'skipped', message: 'That proposal is no longer waiting.' };
  const [c] = await db().select({ orderId: tables.cases.orderId, userId: tables.cases.userId }).from(tables.cases).where(eq(tables.cases.id, p.caseId)).limit(1);
  if (c) await audit({ userId: c.userId, actor: 'merchant', action: 'store_agent.proposal_dismissed', subjectId: c.orderId, payload: { caseId: p.caseId, proposalId } });
  return { kind: 'skipped', message: 'Set aside. Nothing was sent. You can reply yourself below.', proposalId };
}

/**
 * Run the agent after the response is sent, so the buyer never waits for it. Outside a request
 * (scripts, tests) nothing is scheduled; the maintenance sweep picks such cases up instead.
 */
export function scheduleStoreAgent(caseId: string, trigger: StoreAgentTrigger): boolean {
  try {
    after(() => runStoreAgent(caseId, trigger).catch((e) => console.error('[store-agent]', e)));
    return true;
  } catch {
    return false;
  }
}

/**
 * Cases the agent has not looked at yet (a restart lost the scheduled run): new cases waiting for
 * the store, and declined offers with no revision yet. Run from the maintenance job.
 */
export async function storeAgentSweep(limit = 10): Promise<{ looked: string[] }> {
  const waiting = await db().select().from(tables.cases).where(inArray(tables.cases.stage, [...AWAITING_STORE])).limit(100);
  if (!waiting.length) return { looked: [] };
  const proposals = await db()
    .select({ caseId: tables.storeAgentProposals.caseId, triggerRef: tables.storeAgentProposals.triggerRef, status: tables.storeAgentProposals.status })
    .from(tables.storeAgentProposals)
    .where(inArray(tables.storeAgentProposals.caseId, waiting.map((c) => c.id)));
  const looked: string[] = [];
  for (const c of waiting) {
    if (looked.length >= limit) break;
    const mine = proposals.filter((p) => p.caseId === c.id);
    const refs = new Set(mine.map((p) => p.triggerRef));
    let trigger: StoreAgentTrigger | null = null;
    if (c.stage === 'seller_contacted' && refs.size === 0) trigger = { kind: 'case_received' };
    // Every earlier run on this case died part way: try once more.
    else if (c.stage === 'seller_contacted' && mine.every((p) => p.status === 'failed')) trigger = { kind: 'retry' };
    else if (c.stage === 'declined') {
      const [last] = await db()
        .select({ payload: tables.auditLog.payload })
        .from(tables.auditLog)
        .where(and(eq(tables.auditLog.subjectId, c.orderId), eq(tables.auditLog.action, 'case.offer_declined')))
        .orderBy(desc(tables.auditLog.seq))
        .limit(1);
      const offerId = (last?.payload as { offerId?: string } | undefined)?.offerId;
      if (offerId && !refs.has(offerId)) trigger = { kind: 'offer_declined', offerId };
    }
    if (!trigger) continue;
    const run = await runStoreAgent(c.id, trigger).catch(() => null);
    if (run && run.kind !== 'skipped') looked.push(c.id);
  }
  return { looked };
}
