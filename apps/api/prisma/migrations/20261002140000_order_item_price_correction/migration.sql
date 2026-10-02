-- The checkout price/total remain immutable snapshots; only assembly gets an override.
ALTER TABLE "OrderItem" ADD COLUMN "actualPrice" INTEGER;
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_actualPrice_check"
  CHECK ("actualPrice" IS NULL OR "actualPrice" > 0);

CREATE TABLE "OrderItemPriceChange" (
  "id" SERIAL NOT NULL,
  "orderId" INTEGER NOT NULL,
  "itemId" INTEGER NOT NULL,
  "requestId" UUID NOT NULL,
  "previousPrice" INTEGER NOT NULL,
  "newPrice" INTEGER NOT NULL,
  "reason" VARCHAR(500),
  "actorId" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderItemPriceChange_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OrderItemPriceChange_prices_check" CHECK ("previousPrice" > 0 AND "newPrice" > 0 AND "previousPrice" <> "newPrice")
);
CREATE UNIQUE INDEX "OrderItemPriceChange_orderId_requestId_key" ON "OrderItemPriceChange"("orderId", "requestId");
CREATE INDEX "OrderItemPriceChange_itemId_createdAt_idx" ON "OrderItemPriceChange"("itemId", "createdAt");
ALTER TABLE "OrderItemPriceChange" ADD CONSTRAINT "OrderItemPriceChange_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderItemPriceChange" ADD CONSTRAINT "OrderItemPriceChange_itemId_fkey"
  FOREIGN KEY ("itemId") REFERENCES "OrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderItemPriceChange" ADD CONSTRAINT "OrderItemPriceChange_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TYPE "NotificationType" ADD VALUE 'ITEM_PRICE_CHANGED';
ALTER TYPE "NotificationChannel" ADD VALUE 'STAFF_TELEGRAM';
ALTER TABLE "OrderNotification" ADD COLUMN "priceChangeId" INTEGER;
ALTER TABLE "OrderNotification" ADD COLUMN "recipientUserId" INTEGER;
CREATE INDEX "OrderNotification_priceChangeId_idx" ON "OrderNotification"("priceChangeId");
CREATE INDEX "OrderNotification_recipientUserId_idx" ON "OrderNotification"("recipientUserId");
ALTER TABLE "OrderNotification" ADD CONSTRAINT "OrderNotification_priceChangeId_fkey"
  FOREIGN KEY ("priceChangeId") REFERENCES "OrderItemPriceChange"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OrderNotification" ADD CONSTRAINT "OrderNotification_recipientUserId_fkey"
  FOREIGN KEY ("recipientUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
