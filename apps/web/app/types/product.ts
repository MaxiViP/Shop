export type Unit = "GRAM" | "PIECE" | "BUNCH" | "PACK";

export type ProductSort =
  "recommended" | "price_asc" | "price_desc" | "newest" | "name";

export interface ProductListItem {
  id: number;
  name: string;
  slug: string;
  seoTitle?: string | null;
  seoDescription?: string | null;
  indexable?: boolean;

  price: number;
  priceQty: number;

  unit: Unit;
  step: number;
  min: number;
  portionQty: number;

  marketPoint: { slug: string; name: string } | null;

  category: {
    name: string;
    slug: string;
  };

  images: {
    url: string;
    alt: string | null;
  }[];
}

export interface Product extends ProductListItem {
  description: string | null;
}

export interface ProductListResponse {
  currentCategory?: { slug: string; name: string } | null;
  groupTotals?: { current: number; others: number };
  items: ProductListItem[];
  total: number;
  page: number;
  limit: number;
  pages: number;
}

export interface FavoriteListResponse {
  items: ProductListItem[];
}
