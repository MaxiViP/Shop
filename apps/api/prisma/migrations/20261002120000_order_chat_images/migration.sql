-- Existing text messages remain unchanged; photos are optional.
CREATE TYPE "ChatImageRetention" AS ENUM ('OPERATIONAL', 'EVIDENCE');
ALTER TABLE "OrderChatMessage" ADD COLUMN "imageKey" UUID;
ALTER TABLE "OrderChatMessage" ADD COLUMN "imageRequestId" UUID;
ALTER TABLE "OrderChatMessage" ADD COLUMN "imageRetention" "ChatImageRetention";
ALTER TABLE "OrderChatMessage" ADD COLUMN "imageExpiresAt" TIMESTAMP(3);
ALTER TABLE "OrderChatMessage" ADD COLUMN "imageDeletedAt" TIMESTAMP(3);
ALTER TABLE "OrderChatMessage" ADD CONSTRAINT "OrderChatMessage_image_lifecycle_check"
  CHECK (("imageKey" IS NULL OR "imageRetention" IS NOT NULL)
    AND ("imageRequestId" IS NULL OR "imageRetention" IS NOT NULL)
    AND ("imageDeletedAt" IS NULL OR ("imageKey" IS NULL AND "imageRetention" IS NOT NULL)));
CREATE UNIQUE INDEX "OrderChatMessage_imageKey_key" ON "OrderChatMessage"("imageKey");
CREATE UNIQUE INDEX "OrderChatMessage_orderId_imageRequestId_key" ON "OrderChatMessage"("orderId", "imageRequestId");
CREATE INDEX "OrderChatMessage_imageExpiresAt_idx" ON "OrderChatMessage"("imageExpiresAt");
