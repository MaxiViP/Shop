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
    actualPrice: number | null;
    priceQty: number;
  };
}
export interface Coordination {
  status: string;
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
  issueId: number | null;
  authorType: "CUSTOMER" | "SELLER" | "ADMIN" | "SYSTEM";
  recipient?: 'staff' | 'customer' | 'both';
  text: string;
  image: boolean;
  imageExpired: boolean;
  imageRevision: number;
  revisionText: string | null;
  revisionActor: ChatMessage['authorType'] | null;
  revisionAt: string | null;
  createdAt: string;
}
export interface MessagePage {
  unreadMessage: ChatMessage | null;
  readThrough: number;
  messages: ChatMessage[];
  revisions: (Pick<ChatMessage, 'id' | 'imageRevision' | 'imageExpired' | 'revisionText' | 'revisionActor' | 'revisionAt'>)[];
  unreadRevision: { id: number; messageId: number; version: number; message: ChatMessage } | null;
  hasMore: boolean;
}
