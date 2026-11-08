import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MCP_PATH, startHttpServer } from '../src/http';
import { testConfig } from './helpers';

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));

describe('Streamable HTTP transport', () => {
  let http: Server;
  let base: string;
  beforeAll(async () => {
    http = await startHttpServer({ config: testConfig(), port: 0, host: '127.0.0.1', apiKey: 'test-key' });
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => http.close(() => resolve())));

  const initialize = (headers: Record<string, string>) =>
    fetch(`${base}${MCP_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      }),
    });

  it('requires the bearer key', async () => {
    expect((await initialize({})).status).toBe(401);
    expect((await initialize({ authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await initialize({ authorization: 'Bearer test-key' })).status).toBe(200);
  });

  it('refuses foreign Host headers on a loopback server', async () => {
    // fetch() drops a custom Host header, so send this one with node:http.
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        `${base}${MCP_PATH}`,
        { method: 'POST', headers: { host: 'evil.example', authorization: 'Bearer test-key' } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end('{}');
    });
    expect(status).toBe(403);
  });

  it('is stateless: GET is not allowed', async () => {
    const res = await fetch(`${base}${MCP_PATH}`, { headers: { authorization: 'Bearer test-key' } });
    expect(res.status).toBe(405);
  });

  it('serves tools to an SDK client', async () => {
    const client = new Client({ name: 'http-test', version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}${MCP_PATH}`), {
        requestInit: { headers: { authorization: 'Bearer test-key' } },
      }),
    );
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(6);
    const r = (await client.callTool({
      name: 'check_confirmation_phrase',
      arguments: { utterance: 'confirm purchase' },
    })) as CallToolResult;
    expect((r.structuredContent as { decision: string }).decision).toBe('confirm');
    await client.close();
  });
});

describe('stdio transport', () => {
  it('starts, lists tools and answers a readback over stdio', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'src/stdio.ts'],
      cwd: PACKAGE_DIR,
      stderr: 'pipe',
    });
    const client = new Client({ name: 'stdio-test', version: '0.0.0' });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(6);
      const r = (await client.callTool({
        name: 'accessible_readback',
        arguments: {
          items: [
            {
              title: 'Harbor knit crew-neck sweater',
              colour: 'navy',
              size: 'M',
              unit_price: '34.00',
              quantity: 1,
            },
          ],
          seller: 'Demo Store',
          payment_label: 'your saved PayPal',
        },
      })) as CallToolResult;
      expect((r.structuredContent as { text: string }).text).toContain('total $36.72');
    } finally {
      await client.close();
    }
  }, 30_000);
});
