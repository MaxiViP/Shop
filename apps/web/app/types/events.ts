export type StoreEvent = {
  id: number;
  requestId: string;
  actorId: number | null;
  actorName: string;
  actorRole: string;
  source: string;
  category: string;
  title: string;
  entity: string;
  entityId: string;
  operation: string;
  beforeValue: Record<string, unknown> | null;
  afterValue: Record<string, unknown> | null;
  orderId: number | null;
  productId: number | null;
  createdAt: string;
  ownerOnly: boolean;
};
export type EventFeed = {
  items: StoreEvent[];
  total: number;
  next: number | null;
  primary: boolean;
  actors: { id: number; name: string }[];
  cursor: string;
};
