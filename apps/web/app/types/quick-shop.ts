import type { ProductListItem } from './product';
import type { ServerCartSnapshot } from '../utils/cart';

export interface QuickShopSuggestion {
  product: ProductListItem;
  source: 'frequent' | 'favorite' | 'catalog';
  suggestedQty: number;
  lineTotal: number | null;
}

export interface QuickShopResponse {
  cart: ServerCartSnapshot;
  items: QuickShopSuggestion[];
  lastOrder: { id: number; createdAt: string; itemCount: number } | null;
}

export interface RepeatCartResponse {
  cart: ServerCartSnapshot;
  added: number;
  skipped: { productId: number | null; name: string; reason: string }[];
  orderId: number;
}
