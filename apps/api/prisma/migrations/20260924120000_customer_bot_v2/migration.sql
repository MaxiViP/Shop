BEGIN;

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('SMS', 'TELEGRAM');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'ORDER_CONFIRMED';
ALTER TYPE "NotificationType" ADD VALUE 'ASSEMBLY_STARTED';
ALTER TYPE "NotificationType" ADD VALUE 'PAYMENT_RECEIVED';
ALTER TYPE "NotificationType" ADD VALUE 'DELIVERY_CHANGED';
ALTER TYPE "NotificationType" ADD VALUE 'ORDER_COMPLETED';
ALTER TYPE "NotificationType" ADD VALUE 'ORDER_CANCELED';
ALTER TYPE "NotificationType" ADD VALUE 'CHAT_MESSAGE';

-- AlterTable
ALTER TABLE "OrderNotification" ADD COLUMN     "channel" "NotificationChannel" NOT NULL DEFAULT 'SMS',
ADD COLUMN     "messageId" INTEGER;

-- CreateTable
CREATE TABLE "CustomerTelegramSession" (
    "id" UUID NOT NULL,
    "identityId" INTEGER NOT NULL,
    "orderId" INTEGER NOT NULL,
    "action" VARCHAR(16) NOT NULL,
    "step" VARCHAR(16) NOT NULL,
    "promptMessageId" INTEGER,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerTelegramSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomerTelegramSession_identityId_key" ON "CustomerTelegramSession"("identityId");

-- CreateIndex
CREATE INDEX "CustomerTelegramSession_expiresAt_idx" ON "CustomerTelegramSession"("expiresAt");

-- CreateIndex
CREATE INDEX "CustomerTelegramSession_orderId_idx" ON "CustomerTelegramSession"("orderId");

-- CreateIndex
CREATE INDEX "OrderNotification_channel_status_id_idx" ON "OrderNotification"("channel", "status", "id");

-- CreateIndex
CREATE UNIQUE INDEX "OrderNotification_channel_dedupeKey_key" ON "OrderNotification"("channel", "dedupeKey");

-- Keep the old uniqueness protection until the replacement exists.
DROP INDEX "OrderNotification_dedupeKey_key";

-- AddForeignKey
ALTER TABLE "OrderNotification" ADD CONSTRAINT "OrderNotification_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "OrderChatMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerTelegramSession" ADD CONSTRAINT "CustomerTelegramSession_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "TelegramIdentity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerTelegramSession" ADD CONSTRAINT "CustomerTelegramSession_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
