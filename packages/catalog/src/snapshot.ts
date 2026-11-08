import { newId, type ProductSnapshot, type Seller } from '@sightline/core';
import { hashSnapshot } from '@sightline/evidence';
import type { CatalogProduct } from './types';

/**
 * Freeze a catalog product (with its chosen variant) into a snapshot. Every fact the readback
 * speaks and the unboxing check compares comes from here. The seller is always the sandbox
 * Demo Store merchant: orders are placed with it at the listed price.
 */
export function snapshotOf(product: CatalogProduct, seller: Seller, now = new Date(), absoluteImageBase?: string): ProductSnapshot {
  const images = product.images.map((i) => ({
    ...i,
    url: absoluteImageBase && i.url.startsWith('/') ? `${absoluteImageBase.replace(/\/$/, '')}${i.url}` : i.url,
  }));
  const body: Omit<ProductSnapshot, 'hash'> = {
    id: newId('snap'),
    productId: product.id,
    variantId: Object.entries(product.selected)
      .map(([k, v]) => `${k}=${v}`)
      .join(';') || 'default',
    source: product.source,
    title: product.title,
    brand: product.brand,
    category: product.category,
    description: product.description,
    attributes: Object.fromEntries(Object.entries(product.attributes).filter(([, v]) => v !== undefined && v !== '')),
    price: product.price,
    images,
    returnPolicy: product.returnPolicy,
    seller,
    retailerUrl: product.retailerUrl,
    rating: product.rating,
    capturedAt: now.toISOString(),
  };
  // Drop undefined keys so the canonical body is stable.
  const clean = JSON.parse(JSON.stringify(body)) as Omit<ProductSnapshot, 'hash'>;
  return { ...clean, hash: hashSnapshot({ ...clean, hash: '' }) };
}

export function verifySnapshot(s: ProductSnapshot): boolean {
  return hashSnapshot(s) === s.hash;
}
