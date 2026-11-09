import 'server-only';
import { newId } from '@sightline/core';
import { audit } from './audit';

/**
 * The agent's steps for the "what your agent did" timeline, written to the hash-chained audit log
 * as `agent.step`. One entry per meaningful step (a search, a comparison, a question, a memory,
 * a money answer, a readback, a payment), never per token. Summaries are plain sentences built
 * from data: no keys, no secrets, no model text except a question the buyer heard. Lines the
 * grounding check stopped are kept beside the summary (`stopped`) as evidence, never shown as fact.
 *
 * A shopping thread starts with a new search. Its steps carry its threadId; once a readback is
 * made, a `proposed_readback` step carries the readbackId, the conversationId, the threadId and
 * the audit seq of every earlier step in the thread, and later steps carry the readbackId too.
 */
/** 'catalog' is a Demo Store-only search; 'app' is a step the app does itself from templates (the readback). */
export type StepTool = 'claude' | 'channel3' | 'catalog' | 'memory' | 'money' | 'paypal' | 'app';

export interface StepInput {
  tool: StepTool;
  step: string;
  summary: string;
  /** Who decided this step. Defaults: Claude's steps 'model', money answers and templates 'rules'. */
  decided?: 'model' | 'rules' | 'person';
}

const DEFAULT_DECIDED: Partial<Record<StepTool, StepInput['decided']>> = { claude: 'model', money: 'rules', app: 'rules' };

export interface Thread {
  id: string;
  /** Audit seq of each step in this thread, oldest first. */
  steps: number[];
  readbackId?: string;
}

export interface StepContext {
  userId: string;
  conversationId: string;
  state: { thread?: Thread };
}

/** Start a new shopping thread (a new search), unless a readback is being decided. */
export function startThread(ctx: StepContext): Thread {
  ctx.state.thread = { id: newId('thr'), steps: [] };
  return ctx.state.thread;
}

export async function recordStep(ctx: StepContext, s: StepInput, extra: { readbackId?: string; refs?: number[]; stopped?: string[] } = {}): Promise<number | null> {
  const thread = ctx.state.thread ?? startThread(ctx);
  const readbackId = extra.readbackId ?? thread.readbackId;
  try {
    const { seq } = await audit({
      userId: ctx.userId,
      actor: 'agent',
      action: 'agent.step',
      subjectId: readbackId ?? ctx.conversationId,
      payload: {
        tool: s.tool,
        step: s.step,
        summary: s.summary.slice(0, 400),
        ...(s.decided ?? DEFAULT_DECIDED[s.tool] ? { decided: s.decided ?? DEFAULT_DECIDED[s.tool] } : {}),
        conversationId: ctx.conversationId,
        threadId: thread.id,
        ...(readbackId ? { readbackId } : {}),
        ...(extra.refs ? { threadSteps: extra.refs } : {}),
        ...(extra.stopped?.length ? { stopped: extra.stopped.slice(0, 6).map((l) => l.slice(0, 240)) } : {}),
      },
    });
    thread.steps.push(seq);
    // Old threads don't grow without bound in the conversation state.
    if (thread.steps.length > 60) thread.steps.splice(0, thread.steps.length - 60);
    return seq;
  } catch (e) {
    // The timeline is a record, not a gate: a failed write never fails the buyer's turn.
    console.error('[agent-steps] could not record a step', e);
    return null;
  }
}

/** The readback for this thread exists now: record it with every earlier step's seq. */
export async function recordReadbackProposed(ctx: StepContext, readbackId: string, summary: string, tool: StepTool): Promise<void> {
  const thread = ctx.state.thread ?? startThread(ctx);
  const refs = [...thread.steps];
  thread.readbackId = readbackId;
  await recordStep(ctx, { tool, step: 'proposed_readback', summary }, { readbackId, refs });
}
