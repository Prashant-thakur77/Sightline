import 'server-only';
import { catalogFromEnv, snapshotOf, type CatalogProduct, type CatalogSource } from '@sightline/catalog';
import type { ProductSnapshot } from '@sightline/core';
import { appUrl, demoSeller, ENV } from './runtime';

let override: CatalogSource | null = null;

/** Tests only: answer searches from a recorded catalog instead of the network. */
export function setCatalogForTests(source: CatalogSource | null): void {
  override = source;
}

/** The Demo Store's catalog, with live Channel3 results when a key is configured. */
export function catalog(userId?: string): CatalogSource {
  return override ?? catalogFromEnv(ENV, userId);
}

/** Freeze a product into a snapshot. The seller is always the sandbox Demo Store merchant. */
export function freeze(p: CatalogProduct): ProductSnapshot {
  return snapshotOf(p, demoSeller(), new Date(), appUrl());
}
