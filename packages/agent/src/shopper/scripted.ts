/**
 * A scripted stand-in for the model, for tests and the offline eval: each call returns the next
 * scripted reply, built from the request it was given (so a script can use the ids that came back
 * from a search). No network.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { CreateMessage } from './loop';

export type ScriptStep =
  | Anthropic.ContentBlock[]
  | ((
      request: Anthropic.MessageCreateParamsNonStreaming,
    ) =>
      | Anthropic.ContentBlock[]
      | { content: Anthropic.ContentBlock[]; stop_reason: Anthropic.StopReason }
      | Error);

let counter = 0;

export function toolUse(name: string, input: Record<string, unknown>): Anthropic.ToolUseBlock {
  counter++;
  return {
    type: 'tool_use',
    id: `toolu_${counter.toString().padStart(4, '0')}`,
    name,
    input,
    caller: { type: 'direct' },
  } as unknown as Anthropic.ToolUseBlock;
}

export function textBlock(text: string): Anthropic.TextBlock {
  return { type: 'text', text, citations: null } as Anthropic.TextBlock;
}

export function message(
  content: Anthropic.ContentBlock[],
  stop_reason: Anthropic.StopReason = content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
): Anthropic.Message {
  return {
    id: `msg_${++counter}`,
    type: 'message',
    role: 'assistant',
    model: 'scripted',
    content,
    stop_reason,
    stop_sequence: null,
    usage: {
      input_tokens: 1200,
      output_tokens: 80,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  } as unknown as Anthropic.Message;
}

/** The tool results sent back in the last request, by tool name. */
export function lastToolResults(
  request: Anthropic.MessageCreateParamsNonStreaming,
): Array<{ name: string; content: unknown; isError: boolean }> {
  const msgs = request.messages;
  const last = msgs[msgs.length - 1];
  const prev = msgs[msgs.length - 2];
  if (!last || !prev || !Array.isArray(last.content) || !Array.isArray(prev.content)) return [];
  const uses = (prev.content as Array<{ type: string }>).filter(
    (b) => b.type === 'tool_use',
  ) as Anthropic.ToolUseBlockParam[];
  const results = (last.content as Array<{ type: string }>).filter(
    (b) => b.type === 'tool_result',
  ) as Anthropic.ToolResultBlockParam[];
  return results.map((r) => {
    const raw = typeof r.content === 'string' ? r.content : '';
    let content: unknown = raw;
    try {
      content = JSON.parse(raw);
    } catch {
      /* a plain message */
    }
    return {
      name: uses.find((u) => u.id === r.tool_use_id)?.name ?? '?',
      content,
      isError: Boolean(r.is_error),
    };
  });
}

/** The ids of the results of the last search the model saw, best first. */
export function lastResultIds(request: Anthropic.MessageCreateParamsNonStreaming): string[] {
  return lastToolResults(request)
    .filter((r) => r.name === 'search_products' && !r.isError)
    .flatMap((r) => ((r.content as { results?: Array<{ id: string }> }).results ?? []).map((x) => x.id));
}

export interface ScriptedModel {
  create: CreateMessage;
  requests: Anthropic.MessageCreateParamsNonStreaming[];
}

export function scriptedModel(script: ScriptStep[]): ScriptedModel {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  let i = 0;
  const create: CreateMessage = async (body) => {
    requests.push(structuredClone(body));
    const step = script[i++];
    if (!step) throw new Error('The script has no more replies.');
    const out = typeof step === 'function' ? step(body) : step;
    if (out instanceof Error) throw out;
    if (Array.isArray(out)) return message(out);
    return message(out.content, out.stop_reason);
  };
  return { create, requests };
}
