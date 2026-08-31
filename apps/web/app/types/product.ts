export type Unit = "GRAM" | "PIECE" | "BUNCH" | "PACK";

export interface Product {
  id: number;
  name: string;
  slug: string;
  description?: string | null;

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
