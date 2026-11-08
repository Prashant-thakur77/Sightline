import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { configFromEnv, loadRepoEnvFiles } from './config';
import { createServer } from './server';

// stdout carries the protocol: anything else goes to stderr.
loadRepoEnvFiles();
const config = configFromEnv();
const server = createServer(config);
await server.connect(new StdioServerTransport());
console.error(
  `MCP server ready on stdio. Vision service: ${config.visionServiceUrl}. Evidence key: ${
    config.signingKey.ok ? config.signingKey.source : 'invalid RECEIPT_SIGNING_KEY'
  }.`,
);
