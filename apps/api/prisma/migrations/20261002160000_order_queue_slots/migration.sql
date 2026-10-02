CREATE TYPE "FulfillmentMode" AS ENUM ('ASAP', 'SCHEDULED');

ALTER TABLE "Order"
  ADD COLUMN "fulfillmentMode" "FulfillmentMode" NOT NULL DEFAULT 'ASAP',
  ADD COLUMN "scheduledFor" TIMESTAMP(3),
  ADD COLUMN "assemblyStartedAt" TIMESTAMP(3),
  ADD COLUMN "checkoutRequestId" UUID;

-- Existing timed pickup orders remain timed. DeliveryAt on delivery orders is
-- a delivery request and is intentionally not converted into a preparation slot.
UPDATE "Order" SET "fulfillmentMode" = 'SCHEDULED', "scheduledFor" = "deliveryAt"
WHERE "type" = 'PICKUP' AND "deliveryAt" IS NOT NULL;

ALTER TABLE "ShopSettings"
  ADD COLUMN "queueThreshold" INTEGER NOT NULL DEFAULT 4,
  ADD COLUMN "assemblyFallbackMinutes" INTEGER NOT NULL DEFAULT 25,
  ADD COLUMN "assemblyConcurrency" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "peakModeEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "peakModeStart" TIMESTAMP(3),
  ADD COLUMN "peakModeEnd" TIMESTAMP(3),
  ADD COLUMN "slotIntervalMinutes" INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN "slotCapacity" INTEGER NOT NULL DEFAULT 1;

ALTER TYPE "NotificationType" ADD VALUE 'QUEUE_DELAY';
ALTER TYPE "NotificationType" ADD VALUE 'ASSEMBLY_SOON';

CREATE UNIQUE INDEX "Order_checkoutRequestId_key" ON "Order"("checkoutRequestId");
CREATE INDEX "Order_fulfillmentMode_status_scheduledFor_idx" ON "Order"("fulfillmentMode", "status", "scheduledFor");
CREATE INDEX "Order_assemblyFinalizedAt_assemblyStartedAt_idx" ON "Order"("assemblyFinalizedAt", "assemblyStartedAt");

ALTER TABLE "Order" ADD CONSTRAINT "Order_schedule_shape_check"
  CHECK (("fulfillmentMode" = 'ASAP' AND "scheduledFor" IS NULL)
      OR ("fulfillmentMode" = 'SCHEDULED' AND "scheduledFor" IS NOT NULL));
ALTER TABLE "ShopSettings" ADD CONSTRAINT "ShopSettings_queue_limits_check"
  CHECK ("queueThreshold" BETWEEN 1 AND 100
    AND "assemblyFallbackMinutes" BETWEEN 5 AND 180
    AND "assemblyConcurrency" BETWEEN 1 AND 30
    AND "slotIntervalMinutes" IN (15, 30, 60)
    AND "slotCapacity" BETWEEN 1 AND 30
    AND (NOT "peakModeEnabled" OR ("peakModeStart" IS NOT NULL AND "peakModeEnd" > "peakModeStart")));
