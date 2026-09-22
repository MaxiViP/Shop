import type { Unit } from "./product";
export interface AdminImage {
  visible: boolean;
  id: number;
  url: string;
  alt: string | null;
  sort: number;
}
export interface AdminCategory {
  id: number;
  name: string;
  slug: string;
  active: boolean;
  sort: number;
  parentId: number | null;
  _count?: { products: number; children: number };
}
export interface AdminProduct {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  price: number;
  priceQty: number;
  unit: Unit;
  step: number;
  min: number;
  portionQty: number;
  categoryId: number;
  active: boolean;
  sort: number;
  category: AdminCategory;
  images: AdminImage[];
}
export interface AdminPage<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  pages: number;
}
export interface AdminUser {
  id: number;
  name: string | null;
  phone: string | null;
  role: "USER" | "SELLER" | "ADMIN";
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
  protected: boolean;
  orders: number;
  completed: number;
  spent: number;
  unknownTotals: number;
}
export interface AdminUserDetail extends Omit<AdminUser, "orders"> {
  addresses: {
    id: number;
    label: string;
    city: string;
    street: string;
    house: string;
    flat: string | null;
    entrance: string | null;
    floor: string | null;
    intercom: string | null;
    comment: string | null;
    isDefault: boolean;
  }[];
  orders: {
    publicId: string;
    status: string;
    type: string;
    total: number | null;
    finalTotal: number | null;
    createdAt: string;
  }[];
  stats: {
    orders: number;
    completed: number;
    spent: number;
    unknownTotals: number;
  };
}
