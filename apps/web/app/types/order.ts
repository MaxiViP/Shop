export type OrderStatus =
  | "NEW"
  | "CONFIRMED"
  | "ASSEMBLING"
  | "READY"
  | "DELIVERING"
  | "COMPLETED"
  | "CANCELED";

export type OrderType = "DELIVERY" | "PICKUP";

export interface StaffOrder {
  id: number;
  publicId: string;
  type: OrderType;
  status: OrderStatus;

  customerName: string;
  customerPhone: string;

  city: string | null;
  street: string | null;
  house: string | null;

  total: number;
  createdAt: string;

  items: {
    id: number;
    productName: string;
    qty: number;
    unit: string;
    status: OrderItemStatus;
  }[];

  finalTotal: number | null;
}

export interface OrderCreated {
  id: number;
  publicId: string;
  type: OrderType;
  status: OrderStatus;

  subtotal: number;
  deliveryPrice: number;
  total: number;

  createdAt: string;

  items: {
    id: number;
    productName: string;
    qty: number;
    total: number;
  }[];
}

export interface OrderSummary {
  id: number;
  publicId: string;
  type: OrderType;
  status: OrderStatus;

  total: number;
  createdAt: string;

  items: {
    id: number;
    productName: string;
    qty: number;
  }[];
}

export interface OrderDetail {
  id: number;
  publicId: string;
  type: OrderType;
  status: OrderStatus;

  customerName: string;
  customerPhone: string;

  city: string | null;
  street: string | null;
  house: string | null;
  flat: string | null;
  entrance: string | null;
  floor: string | null;
  intercom: string | null;
  comment: string | null;

  deliveryAt: string | null;

  subtotal: number;
  deliveryPrice: number;
  total: number;
  finalSubtotal: number | null;
  finalTotal: number | null;

  createdAt: string;
  updatedAt: string;

  items: {
    id: number;
    productName: string;
    productSlug: string;
    image: string | null;

    price: number;
    priceQty: number;
    unit: string;

    status: OrderItemStatus;
    actualTotal: number | null;

    qty: number;
    actualQty: number | null;
    total: number;
  }[];
}

export type OrderItemStatus = "PENDING" | "PICKED" | "MISSING";

export interface StaffOrderDetail {
  id: number;
  publicId: string;
  type: OrderType;
  status: OrderStatus;

  customerName: string;
  customerPhone: string;

  city: string | null;
  street: string | null;
  house: string | null;
  flat: string | null;
  entrance: string | null;
  floor: string | null;
  intercom: string | null;
  comment: string | null;

  deliveryAt: string | null;

  subtotal: number;
  deliveryPrice: number;
  total: number;

  finalSubtotal: number | null;
  finalTotal: number | null;

  createdAt: string;
  updatedAt: string;

  items: {
    id: number;
    productName: string;
    productSlug: string;
    image: string | null;

    price: number;
    priceQty: number;
    unit: string;

    qty: number;
    actualQty: number | null;

    total: number;
    actualTotal: number | null;

    status: OrderItemStatus;
  }[];
}
