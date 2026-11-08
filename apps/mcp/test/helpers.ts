import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { DEFAULT_WEB_PUBLIC_DIR, resolveSigningKey, type ServerConfig } from '../src/config';
import { createServer } from '../src/server';

export const NOW = new Date('2026-11-09T12:00:00Z');
export const TEST_SEED = 'ab'.repeat(32);

export function testConfig(over: Partial<ServerConfig> = {}): ServerConfig {
  return {
    visionServiceUrl: 'http://127.0.0.1:9',
    signingKey: resolveSigningKey(TEST_SEED),
    barrierResultsPath: '/nonexistent/evals/results/barrier.json',
    webPublicDir: DEFAULT_WEB_PUBLIC_DIR,
    now: () => NOW,
    fetch: globalThis.fetch,
    ...over,
  };
}

/** An MCP client wired to a fresh server over an in-memory transport pair. */
export async function connect(
  over: Partial<ServerConfig> = {},
): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createServer(testConfig(over));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

export async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

export function textOf(r: CallToolResult): string {
  return r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
}

/** A localhost port with nothing listening on it. */
export async function closedPort(): Promise<number> {
  const s = createNetServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}
