import type { Unit } from "./order";
export interface OrderIssue {
  id: number;
  orderItemId: number;
  type: "WEIGHT_DEVIATION" | "MISSING_ITEM" | "REPLACEMENT";
  status: "WAITING_CUSTOMER" | "WAITING_SELLER" | "RESOLVED" | "CANCELED";
  resolution: string | null;
  version: number;
  requestedQty: number;
  actualQty: number | null;
  approvedActualQty: number | null;
  proposedName: string | null;
  proposedPrice: number | null;
  proposedPriceQty: number | null;
  proposedQty: number | null;
  proposedUnit: Unit | null;
  proposedImageUrl: string | null;
  updatedAt: string;
  orderItem: {
    productName: string;
    unit: Unit;
    price: number;
    priceQty: number;
  };
}
export interface Coordination {
  issues: OrderIssue[];
  responseMinutes: number;
  smsAvailable: boolean;
  unread: number;
  readThrough: number;
  notifications: {
    id: number;
    issueId: number | null;
    status: string;
    type: string;
    error: string | null;
  }[];
}
export interface ChatMessage {
  id: number;
  authorType: "CUSTOMER" | "SELLER" | "ADMIN" | "SYSTEM";
  text: string;
  createdAt: string;
}
export interface MessagePage {
  messages: ChatMessage[];
  hasMore: boolean;
}
