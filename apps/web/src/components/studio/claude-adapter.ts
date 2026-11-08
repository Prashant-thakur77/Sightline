import type {
  AgAiConversationItem,
  AgAiEvent,
  AgAiReasoningItem,
  AgLlmAdapter,
  AgLlmExecuteTurnOptions,
  AgLlmRequest,
  AgLlmResponse,
  AgLlmResponseHandler,
} from 'ag-studio';
import type { StudioDashboardId } from './types';

/*
 * The provider boundary for AG Studio's agents. Studio owns the agent loop in the browser and calls
 * `executeTurn` once per model turn; this adapter posts the turn to our own server route, which holds
 * the Anthropic key, talks to Claude and streams back Studio's own event protocol as JSON lines.
 *
 * Wire format from /api/studio/agent, one JSON object per line:
 *   { "type": "event", "event": AgAiEvent }      content as it streams
 *   { "type": "done", "response": AgLlmResponse } the turn's authoritative output
 *   { "type": "error", "message": string }       the turn failed; nothing else follows
 */

/** Claude's thinking travels with Studio's reasoning item, so a tool loop can hand it back verbatim. */
export interface ClaudeThinking {
  /** The thinking text exactly as Claude returned it, with the signature that vouches for it. */
  thinking?: string;
  signature?: string;
  redacted?: string;
}
export type ClaudeReasoningItem = AgAiReasoningItem & { claude?: ClaudeThinking };

type Line = { type: 'event'; event: AgAiEvent } | { type: 'done'; response: AgLlmResponse } | { type: 'error'; message: string };

export interface ClaudeAdapterOptions {
  endpoint: string;
  dashboard: StudioDashboardId;
}

const isReasoning = (item: AgAiConversationItem): item is ClaudeReasoningItem =>
  item.kind === 'output' && item.type === 'reasoning';

export function claudeAdapter({ endpoint, dashboard }: ClaudeAdapterOptions): AgLlmAdapter {
  // Studio keeps output items by reference within a run, so the signature normally rides along on
  // the item. This map is the fallback if an item is ever copied without it.
  const thinking = new Map<string, ClaudeThinking>();

  const withThinking = (input: AgAiConversationItem[]) =>
    input.map((item) => {
      if (!isReasoning(item) || item.claude) return item;
      const known = thinking.get(item.id);
      return known ? { ...item, claude: known } : item;
    });

  const remember = (response: AgLlmResponse) => {
    for (const item of response.output as AgAiConversationItem[]) {
      if (isReasoning(item) && item.claude) thinking.set(item.id, item.claude);
    }
  };

  function executeTurn(request: AgLlmRequest, options?: AgLlmExecuteTurnOptions): AgLlmResponseHandler {
    const outcome: { response?: AgLlmResponse; error?: Error } = {};
    let resolve!: (r: AgLlmResponse) => void;
    let reject!: (e: Error) => void;
    const complete = new Promise<AgLlmResponse>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // A consumer that stops reading early never awaits `complete`; don't let that surface as an
    // unhandled rejection. Anyone who does await it still sees the failure.
    void complete.catch(() => {});

    async function* lines(): AsyncGenerator<AgAiEvent> {
      // The model choice stays on the server: only the turn itself is sent.
      const body = JSON.stringify({
        dashboard,
        turn: {
          input: withThinking(request.input),
          instructions: request.instructions,
          tools: request.tools,
          toolChoice: request.toolChoice,
          responseFormat: request.responseFormat,
        },
      });
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: options?.signal,
      });
      if (!res.ok || !res.body) {
        const j = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(j?.error?.message ?? `The assistant could not answer just now (HTTP ${res.status}).`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n');
        buffer = parts.pop() ?? '';
        for (const raw of parts) {
          if (!raw.trim()) continue;
          const line = JSON.parse(raw) as Line;
          if (line.type === 'event') yield line.event;
          else if (line.type === 'done') outcome.response = line.response;
          else if (line.type === 'error') outcome.error ??= new Error(line.message);
        }
      }
    }

    async function* stream(): AsyncGenerator<AgAiEvent> {
      try {
        yield* lines();
      } catch (e) {
        outcome.error ??= e instanceof Error ? e : new Error(String(e));
      }
      if (outcome.error) reject(outcome.error);
      else if (outcome.response) {
        remember(outcome.response);
        resolve(outcome.response);
      } else reject(new Error('The assistant stopped before it finished its answer.'));
    }

    const it = stream();
    return { stream: { [Symbol.asyncIterator]: () => it }, complete };
  }

  return { executeTurn };
}
