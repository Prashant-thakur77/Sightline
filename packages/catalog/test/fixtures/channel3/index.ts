import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RecordedSearch } from '../../../src/recorded';

/**
 * Real Channel3 search responses, recorded on 9 November 2026 and trimmed to the fields the app
 * reads (tracking parameters removed from URLs, descriptions shortened). Each key names a file;
 * the value is the query the recording answers.
 */
const here = path.dirname(fileURLToPath(import.meta.url));

export const RECORDED_QUERIES: Record<string, string> = {
  'navy-sweater-palette': 'navy sweater',
  'navy-sweater': 'navy wool sweater',
  'navy-hoodie-palette': 'navy hoodie',
  'navy-crewneck-sweatshirt': 'navy crewneck sweatshirt',
  'crew-neck-sweater-size-m': 'crew neck sweater size m',
  'merino-hiking-socks-under-50': 'merino hiking socks',
  'soft-cotton-sweater-under-60': 'soft cotton sweater',
};

export function recording(name: string): { products: unknown[] } {
  return JSON.parse(readFileSync(path.join(here, `${name}.json`), 'utf8')) as { products: unknown[] };
}

export function recordedSearches(): RecordedSearch[] {
  return Object.entries(RECORDED_QUERIES).map(([name, query]) => ({ query, body: recording(name) }));
}
