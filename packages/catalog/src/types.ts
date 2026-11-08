import type { Money, ProductAttributes, ProductImage, ReturnPolicy } from '@sightline/core';

export interface VariantOptionValue {
  label: string;
  available: boolean;
}

export interface VariantOption {
  name: string;
  values: VariantOptionValue[];
}

/** A product as Sightline sees it, before a variant is chosen. */
export interface CatalogProduct {
  id: string;
  source: 'channel3' | 'demo-store';
  title: string;
  brand?: string;
  category?: string;
  description?: string;
  materials?: string[];
  keyFeatures?: string[];
  attributes: ProductAttributes;
  price: Money;
  compareAtPrice?: Money;
  available: boolean;
  images: ProductImage[];
  options: VariantOption[];
  selected: Record<string, string>;
  returnPolicy: ReturnPolicy | null;
  retailerDomain?: string;
  retailerUrl?: string;
  rating?: { average: number; count: number };
  /** Short quoted review lines with their source, used only as quotes. */
  reviews?: { quote: string; rating?: number }[];
}

export interface SearchQuery {
  text: string;
  category?: string;
  colour?: string;
  size?: string;
  maxPrice?: Money;
  minPrice?: Money;
  limit?: number;
}

export interface CatalogSource {
  name: 'channel3' | 'demo-store';
  search(q: SearchQuery): Promise<CatalogProduct[]>;
  get(id: string, selection?: Record<string, string>): Promise<CatalogProduct | null>;
}
