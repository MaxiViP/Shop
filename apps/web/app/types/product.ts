export type Unit = "GRAM" | "PIECE" | "BUNCH" | "PACK";

export type ProductSort =
  "recommended" | "price_asc" | "price_desc" | "newest" | "name";

export interface ProductListItem {
  id: number;
  name: string;
  slug: string;

  price: number;
  priceQty: number;

  unit: Unit;
  step: number;
  min: number;

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
  items: ProductListItem[];
  total: number;
  page: number;
  limit: number;
  pages: number;
}

export interface FavoriteListResponse {
  items: ProductListItem[];
}
