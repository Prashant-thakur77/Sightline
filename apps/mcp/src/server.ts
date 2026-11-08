import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PRODUCT_NAME } from '@sightline/core';
import type { ServerConfig } from './config';
import { READBACK_RULES_URI, registerRules } from './rules';
import { registerBarrier } from './tools/barrier';
import { registerConfirmation } from './tools/confirmation';
import { registerDelivery } from './tools/delivery';
import { registerEvidence } from './tools/evidence';
import { registerReadback } from './tools/readback';

export const SERVER_VERSION = '0.1.0';

const INSTRUCTIONS = [
  `${PRODUCT_NAME} helps shopping agents buy safely for blind and low-vision people, and recover money when a delivery is wrong.`,
  'Before paying: call accessible_readback and speak its text verbatim, then pass the reply to check_confirmation_phrase. A "confirm" there is only key 1 of 2; a second independent key is required before any money moves.',
  'After delivery: verify_delivery checks photos against the listing; on a mismatch, build_evidence_pack makes a signed pack and verify_evidence_pack checks one.',
  `Read ${READBACK_RULES_URI} for the full rules.`,
].join(' ');

/** One server per connection (stdio) or per request (stateless HTTP); config is shared. */
export function createServer(config: ServerConfig): McpServer {
  const server = new McpServer(
    { name: PRODUCT_NAME.toLowerCase(), title: PRODUCT_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );
  registerReadback(server, config);
  registerConfirmation(server);
  registerDelivery(server, config);
  registerEvidence(server, config);
  registerBarrier(server, config);
  registerRules(server);
  return server;
}
