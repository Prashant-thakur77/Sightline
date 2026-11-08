import { createHash, timingSafeEqual } from 'node:crypto';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { configFromEnv, loadRepoEnvFiles, type ServerConfig } from './config';
import { createServer } from './server';

export const MCP_PATH = '/mcp';
/** Photos travel as base64, so allow more than the transport's 4 MiB default. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

export interface HttpOptions {
  config: ServerConfig;
  port: number;
  host: string;
  /** When set, every request must carry `Authorization: Bearer <apiKey>`. */
  apiKey?: string;
}

function digest(s: string): Buffer {
  return createHash('sha256').update(s, 'utf8').digest();
}

function authorised(req: IncomingMessage, apiKey: string): boolean {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
  return !!m && timingSafeEqual(digest(m[1]!.trim()), digest(apiKey));
}

function jsonRpcError(
  res: ServerResponse,
  status: number,
  message: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

/** Host header hostname without the port, e.g. "localhost" or "[::1]". */
function hostnameOf(req: IncomingMessage): string {
  const host = req.headers.host ?? '';
  return host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]!;
}

export function startHttpServer(opts: HttpOptions): Promise<Server> {
  const loopbackOnly = LOOPBACK.has(opts.host);
  const http = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (url.pathname !== MCP_PATH) return jsonRpcError(res, 404, 'Not found. The MCP endpoint is /mcp.');
    // A server bound to loopback only answers to local host names, which stops DNS rebinding.
    if (loopbackOnly && !LOCAL_HOSTNAMES.has(hostnameOf(req)))
      return jsonRpcError(res, 403, 'Host not allowed.');
    if (opts.apiKey && !authorised(req, opts.apiKey))
      return jsonRpcError(res, 401, 'Missing or wrong API key. Send Authorization: Bearer <key>.', {
        'www-authenticate': 'Bearer',
      });
    // Stateless: no sessions, so there is no standalone event stream to GET or session to DELETE.
    if (req.method !== 'POST')
      return jsonRpcError(res, 405, 'Method not allowed. This server is stateless: use POST.', {
        allow: 'POST',
      });

    const server = createServer(opts.config);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      maxRequestBodySize: MAX_BODY_BYTES,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      console.error('MCP request failed:', e);
      if (!res.headersSent) jsonRpcError(res, 500, 'Internal server error.');
    }
  });
  return new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(opts.port, opts.host, () => resolve(http));
  });
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  loadRepoEnvFiles();
  const config = configFromEnv();
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST?.trim() || '127.0.0.1';
  const apiKey = process.env.MCP_API_KEY?.trim() || undefined;
  if (!apiKey && !LOOPBACK.has(host))
    console.error(`Warning: listening on ${host} without MCP_API_KEY. Anyone who can reach it can use it.`);
  const http = await startHttpServer({ config, port, host, apiKey });
  const { port: bound } = http.address() as AddressInfo;
  console.error(
    `MCP server listening on http://${host}:${bound}${MCP_PATH} (stateless${apiKey ? ', bearer auth on' : ', no auth'}). Vision service: ${config.visionServiceUrl}.`,
  );
}
