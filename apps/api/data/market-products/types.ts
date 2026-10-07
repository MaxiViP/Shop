import type { MarketPointKind, ProductPriceStatus } from '../../src/db/gen/client.js';

export interface MarketProduct {
  slug: string;
  name: string;
  sellerPrice: number;
  priceStatus: ProductPriceStatus;
  categorySlug: string;
  marketPointSlug: string;
  sourceUrl: string;
  sourceCheckedAt: string;
  unit: 'GRAM' | 'PIECE';
  priceQty: number;
  step: number;
  min: number;
  portionQty: number;
}

export interface MarketDataset {
  categories: readonly { slug: string; name: string; sort: number; aliases?: readonly string[] }[];
  expectedCounts: Readonly<Record<string, number>>;
  marketProducts: readonly MarketProduct[];
  marketPoints?: readonly { slug: string; name: string; kind: Exclude<MarketPointKind, 'ENTRY'>;
    aliases?: readonly string[]; unitNumber?: string }[];
}
