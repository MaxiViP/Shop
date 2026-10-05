-- Additive changes only. Existing messages, image revisions and bookings remain intact.
ALTER TABLE "OrderChatMessage" ADD COLUMN "requestId" UUID;
CREATE UNIQUE INDEX "OrderChatMessage_orderId_requestId_key" ON "OrderChatMessage"("orderId", "requestId");

ALTER TYPE "NotificationType" ADD VALUE 'CHAT_IMAGE_REVISION';
ALTER TABLE "OrderNotification" ADD COLUMN "imageRevisionId" INTEGER;
-- Persist provider rate-limit deadlines across process restarts.
ALTER TABLE "OrderNotification" ADD COLUMN "retryAt" TIMESTAMP(3);
ALTER TABLE "OrderNotification" ADD CONSTRAINT "OrderNotification_imageRevisionId_fkey"
  FOREIGN KEY ("imageRevisionId") REFERENCES "OrderChatImageRevision"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ShopSettings"
  ADD COLUMN "peakAssemblyConcurrency" INTEGER,
  ADD COLUMN "peakAssemblyMinutes" INTEGER,
  ADD COLUMN "peakQueueThreshold" INTEGER,
  ADD COLUMN "peakSlotCapacity" INTEGER;

-- Preserve the deployed peak behavior until the owner configures a separate profile.
UPDATE "ShopSettings" SET
  "peakAssemblyConcurrency" = "assemblyConcurrency",
  "peakAssemblyMinutes" = "assemblyFallbackMinutes",
  "peakQueueThreshold" = "queueThreshold",
  "peakSlotCapacity" = "slotCapacity";

ALTER TABLE "ShopSettings" ADD CONSTRAINT "ShopSettings_peak_profile_check"
  CHECK (("peakAssemblyConcurrency" IS NULL OR "peakAssemblyConcurrency" BETWEEN 1 AND 30)
    AND ("peakAssemblyMinutes" IS NULL OR "peakAssemblyMinutes" BETWEEN 5 AND 180)
    AND ("peakQueueThreshold" IS NULL OR "peakQueueThreshold" BETWEEN 1 AND 100)
    AND ("peakSlotCapacity" IS NULL OR "peakSlotCapacity" BETWEEN 1 AND 30));
