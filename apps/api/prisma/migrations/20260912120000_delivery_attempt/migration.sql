CREATE TYPE "DeliveryAttemptState" AS ENUM ('RESERVED', 'CREATED', 'ACCEPTED', 'ACTIVE', 'NEEDS_REVIEW');

CREATE TABLE "DeliveryAttempt" (
    "orderId" INTEGER NOT NULL,
    "provider" "DeliveryProvider" NOT NULL,
    "requestId" UUID NOT NULL,
    "externalOrderId" TEXT,
    "state" "DeliveryAttemptState" NOT NULL DEFAULT 'RESERVED',
    "requestBody" TEXT,
    "providerStatus" TEXT,
    "lastError" TEXT,
    "leaseToken" UUID,
    "leaseUntil" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DeliveryAttempt_pkey" PRIMARY KEY ("orderId"),
    CONSTRAINT "DeliveryAttempt_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "DeliveryAttempt_requestId_key" ON "DeliveryAttempt"("requestId");
CREATE UNIQUE INDEX "DeliveryAttempt_externalOrderId_key" ON "DeliveryAttempt"("externalOrderId");
CREATE INDEX "DeliveryAttempt_state_leaseUntil_idx" ON "DeliveryAttempt"("state", "leaseUntil");
-- Existing deliveries are already linked to their claims; no guessed attempts/backfill.
