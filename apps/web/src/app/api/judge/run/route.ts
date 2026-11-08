import { runLifecycle } from '@/server/lifecycle';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

let running = false;

/** Streams the scripted lifecycle run as server-sent events. One run at a time per server. */
export async function POST() {
  if (running) return new Response(JSON.stringify({ error: 'A run is already in progress. Try again in a minute.' }), { status: 429 });
  running = true;
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const ev of runLifecycle()) controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
      } catch (e) {
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ step: 0, title: 'Run stopped', status: 'failed', detail: (e as Error).message })}\n\n`));
      } finally {
        running = false;
        controller.enqueue(enc.encode('data: {"end":true}\n\n'));
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } });
}
