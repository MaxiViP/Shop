export interface Category {
  id: number;
  name: string;
  slug: string;
  description?: string | null;
  seoTitle?: string | null;
  seoDescription?: string | null;
  image?: string | null;
  indexable?: boolean;
}
