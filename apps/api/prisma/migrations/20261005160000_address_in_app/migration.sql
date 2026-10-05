-- Additive: existing addresses, order snapshots and outbox deliveries are preserved.
ALTER TABLE "Address" ADD COLUMN "buildingPart" VARCHAR(50);
ALTER TABLE "Order" ADD COLUMN "buildingPart" VARCHAR(50);
ALTER TYPE "NotificationChannel" ADD VALUE 'IN_APP';
ALTER TYPE "NotificationType" ADD VALUE 'ORDER_STATUS_CHANGED';
ALTER TYPE "NotificationType" ADD VALUE 'SCHEDULE_CHANGED';
ALTER TABLE "OrderNotification"
  ADD COLUMN "audience" VARCHAR(8) NOT NULL DEFAULT 'CUSTOMER',
  ADD COLUMN "seenAt" TIMESTAMP(3),
  ADD COLUMN "eventData" JSONB;
ALTER TABLE "OrderNotification" ADD CONSTRAINT "OrderNotification_audience_check"
  CHECK ("audience" IN ('CUSTOMER', 'STAFF'));
CREATE INDEX "OrderNotification_channel_seenAt_id_idx" ON "OrderNotification"("channel", "seenAt", "id");
