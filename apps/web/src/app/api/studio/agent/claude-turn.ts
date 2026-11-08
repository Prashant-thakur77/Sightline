import 'server-only';
import type {
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaRawMessageStreamEvent,
  BetaTextBlockParam,
  BetaTool,
  BetaToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { AgAiEvent, AgAiOutputItem, AgLlmResponse } from 'ag-studio';
import { z } from 'zod';
import type { ClaudeReasoningItem, ClaudeThinking } from '@/components/studio/claude-adapter';

/*
 * One AG Studio model turn, translated both ways:
 *   Studio's conversation items and tool schemas  ->  a Claude Messages request
 *   Claude's stream and final message             ->  Studio's event protocol and AgLlmResponse
 *
 * Claude's thinking blocks ride along on Studio's reasoning items (`claude` field) and go back
 * unchanged within a tool loop. Output items are given ids `<message id>#<block index>`, so items
 * from one Claude turn are kept together when Studio interleaves tool results between them.
 */

// --- Request validation --------------------------------------------------------------------------

const ToolSchema = z.looseObject({
  name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  description: z.string().max(20_000),
  parameters: z.record(z.string(), z.unknown()),
  kind: z.enum(['client', 'server', 'provided']).optional(),
});

export const TurnRequest = z.object({
  dashboard: z.enum(['verified-delivery', 'barrier-index']),
  turn: z.object({
    input: z.array(z.record(z.string(), z.unknown())).min(1).max(400),
    instructions: z.string().max(100_000).optional(),
    tools: z.array(ToolSchema).max(64).optional(),
    toolChoice: z.union([z.enum(['auto', 'none', 'required']), z.object({ name: z.string().max(64) })]).optional(),
    responseFormat: z
      .union([
        z.object({ type: z.literal('text') }),
        z.object({
          type: z.literal('json'),
          name: z.string().max(128),
          description: z.string().max(4000).optional(),
          schema: z.record(z.string(), z.unknown()),
        }),
      ])
      .optional(),
  }),
});
export type TurnRequest = z.infer<typeof TurnRequest>;

// --- Conversation: Studio -> Claude -------------------------------------------------------------

type Item = Record<string, unknown>;

const str = (x: unknown) => (typeof x === 'string' ? x : '');
const isClaudeToolId = (id: string) => /^(toolu|srvtoolu)_[A-Za-z0-9_-]+$/.test(id);
const turnKey = (id: string) => (id.includes('#') ? id.slice(0, id.indexOf('#')) : null);

function parseArgs(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function inputContent(item: Item): BetaContentBlockParam[] {
  const parts = Array.isArray(item.content) ? (item.content as Item[]) : [];
  const out: BetaContentBlockParam[] = [];
  for (const c of parts) {
    if (c.type === 'text' && str(c.text)) out.push({ type: 'text', text: str(c.text) });
    else if (c.type === 'image') {
      const url = str(c.imageUrl);
      const m = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/.exec(url);
      if (m) out.push({ type: 'image', source: { type: 'base64', media_type: m[1] as 'image/png', data: m[2]! } });
      else if (/^https:\/\//.test(url)) out.push({ type: 'image', source: { type: 'url', url } });
    } else if (c.type === 'file') {
      out.push({ type: 'text', text: `[A file was attached: ${str(c.filename) || 'unnamed'}. Files are not read here.]` });
    }
  }
  return out;
}

/**
 * Builds the Messages array. Rules the API needs and Studio does not guarantee:
 * - tool_use blocks of one turn share one assistant message, and every tool_result for them comes
 *   first in the very next user message;
 * - calls Studio ran itself before the model's first turn (ids that are not Claude's) become plain
 *   context text, because no assistant turn ever asked for them;
 * - the conversation starts and ends with the user.
 */
export function toMessages(items: Item[]): BetaMessageParam[] {
  const out: BetaMessageParam[] = [];
  let assistant: BetaContentBlockParam[] | null = null;
  let key: string | null = null;
  let results: BetaToolResultBlockParam[] = [];
  let texts: BetaContentBlockParam[] = [];
  const calls = new Set<string>();
  const seeded = new Map<string, string>();

  const push = (m: BetaMessageParam) => {
    const last = out.at(-1);
    if (last && last.role === m.role && Array.isArray(last.content) && Array.isArray(m.content)) {
      // Keep tool results ahead of text when two user messages merge.
      const merged = [...last.content, ...m.content] as BetaContentBlockParam[];
      last.content = [...merged.filter((b) => b.type === 'tool_result'), ...merged.filter((b) => b.type !== 'tool_result')];
    } else out.push(m);
  };
  const flushAssistant = () => {
    if (assistant?.length) push({ role: 'assistant', content: assistant });
    assistant = null;
    key = null;
  };
  const flushUser = () => {
    if (results.length || texts.length) push({ role: 'user', content: [...results, ...texts] });
    results = [];
    texts = [];
  };

  for (const item of items) {
    if (item.kind === 'input' && item.type === 'message') {
      flushAssistant();
      const content = inputContent(item);
      if (item.role === 'system')
        texts.push(...content.map((b) => (b.type === 'text' ? { ...b, text: `Note from the dashboard: ${b.text}` } : b)));
      else texts.push(...content);
      continue;
    }
    if (item.type === 'function_call_output') {
      const callId = str(item.callId);
      const output = str(item.output);
      if (calls.has(callId)) results.push({ type: 'tool_result', tool_use_id: callId, content: output || '(no output)' });
      else {
        const name = seeded.get(callId) ?? 'a tool';
        texts.push({ type: 'text', text: `Studio ran ${name} before this turn. Its result:\n${output}` });
      }
      continue;
    }
    if (item.kind !== 'output') continue;

    const id = str(item.id);
    if (item.type === 'function_call' && !isClaudeToolId(str(item.callId))) {
      seeded.set(str(item.callId), str(item.name));
      continue;
    }
    const k = turnKey(id);
    const newTurn = texts.length > 0 || (results.length > 0 && (k === null || k !== key));
    if (newTurn) {
      flushAssistant();
      flushUser();
    }
    if (!assistant) {
      assistant = [];
      key = k;
    }
    if (item.type === 'reasoning') {
      const c = item.claude as ClaudeThinking | undefined;
      if (c?.signature !== undefined) assistant.push({ type: 'thinking', thinking: c.thinking ?? '', signature: c.signature });
      else if (c?.redacted) assistant.push({ type: 'redacted_thinking', data: c.redacted });
    } else if (item.type === 'message') {
      for (const c of (Array.isArray(item.content) ? item.content : []) as Item[]) {
        const text = c.type === 'refusal' ? str(c.refusal) : str(c.text);
        if (text) assistant.push({ type: 'text', text });
      }
    } else if (item.type === 'function_call') {
      const callId = str(item.callId);
      calls.add(callId);
      assistant.push({ type: 'tool_use', id: callId, name: str(item.name), input: parseArgs(str(item.arguments)) });
    }
  }
  flushAssistant();
  flushUser();

  // Every tool_use needs its result in the next user message; anything else is turned into text.
  for (let i = 0; i < out.length; i++) {
    const m = out[i]!;
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    const ids = m.content.filter((b) => b.type === 'tool_use').map((b) => (b as { id: string }).id);
    if (ids.length === 0) continue;
    let next = out[i + 1];
    if (!next || next.role !== 'user') {
      next = { role: 'user', content: [] };
      out.splice(i + 1, 0, next);
    }
    const content = (Array.isArray(next.content) ? next.content : [{ type: 'text', text: next.content }]) as BetaContentBlockParam[];
    const have = new Set(content.filter((b) => b.type === 'tool_result').map((b) => (b as BetaToolResultBlockParam).tool_use_id));
    const missing: BetaToolResultBlockParam[] = ids
      .filter((tid) => !have.has(tid))
      .map((tid) => ({ type: 'tool_result', tool_use_id: tid, content: 'No result was recorded for this call.', is_error: true }));
    next.content = [...missing, ...content];
  }
  for (let i = 0; i < out.length; i++) {
    const m = out[i]!;
    if (m.role !== 'user' || !Array.isArray(m.content)) continue;
    const prev = out[i - 1];
    const allowed = new Set(
      prev?.role === 'assistant' && Array.isArray(prev.content)
        ? prev.content.filter((b) => b.type === 'tool_use').map((b) => (b as { id: string }).id)
        : [],
    );
    m.content = m.content.map((b) =>
      b.type === 'tool_result' && !allowed.has(b.tool_use_id)
        ? ({ type: 'text', text: `An earlier tool result: ${typeof b.content === 'string' ? b.content : ''}` } as BetaTextBlockParam)
        : b,
    );
  }
  if (out[0]?.role !== 'user') out.unshift({ role: 'user', content: [{ type: 'text', text: '(Earlier in this conversation.)' }] });
  if (out.at(-1)?.role !== 'user') out.push({ role: 'user', content: [{ type: 'text', text: 'Continue.' }] });
  return out;
}

/** Studio's turn-level steer (a forced tool) as words, since the model only takes tool_choice auto or none. */
export function steer(messages: BetaMessageParam[], choice: TurnRequest['turn']['toolChoice']): void {
  const text =
    choice === 'required'
      ? 'Use one of your tools for this step.'
      : choice && typeof choice === 'object'
        ? `Call the ${choice.name} tool now.`
        : null;
  const last = messages.at(-1);
  if (!text || !last || !Array.isArray(last.content)) return;
  last.content = [...last.content, { type: 'text', text }];
}

// --- Tools ----------------------------------------------------------------------------------------

type Schema = Record<string, unknown>;

/** Shape encodes "may be undefined" as `{ not: {} }` inside anyOf; drop it, the field is simply optional. */
function clean(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(clean);
  if (!schema || typeof schema !== 'object') return schema;
  const s = { ...(schema as Schema) };
  delete s.$schema;
  if (Array.isArray(s.anyOf)) {
    const kept = (s.anyOf as unknown[]).filter(
      (b) => !(b && typeof b === 'object' && Object.keys(b).length === 1 && 'not' in (b as Schema) && Object.keys((b as Schema).not as Schema).length === 0),
    );
    if (kept.length === 1 && kept[0] && typeof kept[0] === 'object') {
      delete s.anyOf;
      Object.assign(s, kept[0] as Schema);
    } else s.anyOf = kept;
  }
  for (const [k, v] of Object.entries(s)) if (v && typeof v === 'object') s[k] = clean(v);
  return s;
}

export function toTools(tools: TurnRequest['turn']['tools']): BetaTool[] {
  return (tools ?? [])
    .filter((t) => t.kind !== 'provided')
    .map((t) => {
      const schema = clean(t.parameters) as Schema;
      const input_schema = schema.type === 'object' ? schema : { type: 'object' as const, properties: {} };
      return { name: t.name, description: t.description, input_schema: input_schema as BetaTool['input_schema'] };
    });
}

// --- Stream: Claude -> Studio ---------------------------------------------------------------------

type Kind = 'text' | 'thinking' | 'tool' | 'other';

/** Claude's stream events as Studio's message, reasoning and tool-call events. */
export class StreamTranslator {
  private messageId = 'msg';
  private readonly kinds = new Map<number, Kind>();
  private readonly toolIds = new Map<number, string>();

  private id(index: number) {
    return `${this.messageId}#${index}`;
  }

  translate(e: BetaRawMessageStreamEvent): AgAiEvent[] {
    switch (e.type) {
      case 'message_start':
        this.messageId = e.message.id;
        return [];
      case 'content_block_start': {
        const b = e.content_block;
        if (b.type === 'text') {
          this.kinds.set(e.index, 'text');
          return [{ type: 'TEXT_MESSAGE_START', messageId: this.id(e.index), role: 'assistant' }];
        }
        if (b.type === 'thinking') {
          this.kinds.set(e.index, 'thinking');
          return [{ type: 'REASONING_MESSAGE_START', messageId: this.id(e.index), role: 'reasoning' }];
        }
        if (b.type === 'tool_use') {
          this.kinds.set(e.index, 'tool');
          this.toolIds.set(e.index, b.id);
          return [{ type: 'TOOL_CALL_START', toolCallId: b.id, toolCallName: b.name }];
        }
        this.kinds.set(e.index, 'other');
        return [];
      }
      case 'content_block_delta': {
        const d = e.delta;
        if (d.type === 'text_delta' && d.text) return [{ type: 'TEXT_MESSAGE_CONTENT', messageId: this.id(e.index), delta: d.text }];
        if (d.type === 'thinking_delta' && d.thinking)
          return [{ type: 'REASONING_MESSAGE_CONTENT', messageId: this.id(e.index), delta: d.thinking }];
        if (d.type === 'input_json_delta' && d.partial_json) {
          const toolCallId = this.toolIds.get(e.index);
          return toolCallId ? [{ type: 'TOOL_CALL_ARGS', toolCallId, delta: d.partial_json }] : [];
        }
        return [];
      }
      case 'content_block_stop': {
        const kind = this.kinds.get(e.index);
        if (kind === 'text') return [{ type: 'TEXT_MESSAGE_END', messageId: this.id(e.index) }];
        if (kind === 'thinking') return [{ type: 'REASONING_MESSAGE_END', messageId: this.id(e.index) }];
        if (kind === 'tool') {
          const toolCallId = this.toolIds.get(e.index);
          return toolCallId ? [{ type: 'TOOL_CALL_END', toolCallId }] : [];
        }
        return [];
      }
      default:
        return [];
    }
  }
}

export const REFUSAL_TEXT = "I can't help with that one. Ask me about the data on this dashboard.";

/** The finished Claude message as Studio's authoritative turn output. */
export function toResponse(m: BetaMessage): { response: AgLlmResponse; extra: AgAiEvent[] } {
  const extra: AgAiEvent[] = [];
  const output: AgAiOutputItem[] = [];
  // After a mid-stream fallback, only the text from before the switch is kept.
  let lastFallback = -1;
  m.content.forEach((b, i) => {
    if (b.type === 'fallback') lastFallback = i;
  });
  const truncated = m.stop_reason === 'max_tokens';
  m.content.forEach((b, i) => {
    if (b.type === 'fallback' || (i < lastFallback && b.type !== 'text')) return;
    const id = `${m.id}#${i}`;
    if (b.type === 'text' && b.text) {
      output.push({ id, kind: 'output', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'text', text: b.text, annotations: [] }] });
    } else if (b.type === 'thinking') {
      const claude: ClaudeThinking = { thinking: b.thinking, signature: b.signature };
      const item: ClaudeReasoningItem = { id, kind: 'output', type: 'reasoning', summary: b.thinking ? [{ type: 'summary', text: b.thinking }] : [], claude };
      output.push(item);
    } else if (b.type === 'redacted_thinking') {
      const item: ClaudeReasoningItem = { id, kind: 'output', type: 'reasoning', summary: [], claude: { redacted: b.data } };
      output.push(item);
    } else if (b.type === 'tool_use') {
      // A tool call cut off by the token cap is never run.
      if (truncated && i === m.content.length - 1) return;
      output.push({ id, kind: 'output', type: 'function_call', callId: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}), status: 'completed' });
    }
  });

  if (m.stop_reason === 'refusal') {
    // Keep nothing from a declined turn, and say so in plain words.
    output.length = 0;
    const id = `${m.id}#refusal`;
    output.push({ id, kind: 'output', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: REFUSAL_TEXT }] });
    extra.push(
      { type: 'TEXT_MESSAGE_START', messageId: id, role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: id, delta: REFUSAL_TEXT },
      { type: 'TEXT_MESSAGE_END', messageId: id },
    );
  }

  const u = m.usage;
  const cached = u.cache_read_input_tokens ?? 0;
  const written = u.cache_creation_input_tokens ?? 0;
  return {
    extra,
    response: {
      id: m.id,
      createdAt: Date.now(),
      model: m.model,
      output,
      status: truncated ? 'incomplete' : 'completed',
      ...(truncated && { incompleteDetails: { reason: 'max_output_tokens' as const } }),
      usage: {
        inputTokens: u.input_tokens + cached + written,
        outputTokens: u.output_tokens,
        totalTokens: u.input_tokens + cached + written + u.output_tokens,
        reasoningTokens: u.output_tokens_details?.thinking_tokens,
        cachedInputTokens: cached,
        cacheWriteTokens: written,
      },
    },
  };
}
