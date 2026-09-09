-- CreateEnum
CREATE TYPE "IssueType" AS ENUM ('WEIGHT_DEVIATION', 'MISSING_ITEM', 'REPLACEMENT');

-- CreateEnum
CREATE TYPE "IssueStatus" AS ENUM ('WAITING_CUSTOMER', 'WAITING_SELLER', 'RESOLVED', 'CANCELED');

-- CreateEnum
CREATE TYPE "IssueResolution" AS ENUM ('ACCEPT_ACTUAL', 'REQUEST_REDUCE', 'REMOVE_ITEM', 'ACCEPT_REPLACEMENT', 'SELLER_ADJUSTED', 'CANCEL_ORDER');

-- CreateEnum
CREATE TYPE "MessageAuthor" AS ENUM ('CUSTOMER', 'SELLER', 'ADMIN', 'SYSTEM');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('ACTION_REQUIRED', 'PAYMENT_READY');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED', 'UNCONFIGURED', 'CANCELED');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "customerReadMessageId" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "customerUnread" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "staffReadMessageId" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "staffUnread" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "ShopSettings" ADD COLUMN     "customerResponseMinutes" INTEGER NOT NULL DEFAULT 10;

-- CreateTable
CREATE TABLE "OrderIssue" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "orderItemId" INTEGER NOT NULL,
    "type" "IssueType" NOT NULL,
    "status" "IssueStatus" NOT NULL DEFAULT 'WAITING_CUSTOMER',
    "version" INTEGER NOT NULL DEFAULT 1,
    "requestedQty" INTEGER NOT NULL,
    "actualQty" INTEGER,
    "approvedActualQty" INTEGER,
    "resolution" "IssueResolution",
    "resolvedAt" TIMESTAMP(3),
    "createdById" INTEGER,
    "proposedProductId" INTEGER,
    "proposedName" TEXT,
    "proposedSlug" TEXT,
    "proposedPrice" INTEGER,
    "proposedPriceQty" INTEGER,
    "proposedUnit" "Unit",
    "proposedQty" INTEGER,
    "proposedImageUrl" TEXT,
    "replacementItemId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderIssue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderChatMessage" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "issueId" INTEGER,
    "authorType" "MessageAuthor" NOT NULL,
    "authorUserId" INTEGER,
    "text" VARCHAR(2000) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderNotification" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "issueId" INTEGER,
    "issueVersion" INTEGER,
    "type" "NotificationType" NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "dedupeKey" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderNotification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrderIssue_orderItemId_key" ON "OrderIssue"("orderItemId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderIssue_replacementItemId_key" ON "OrderIssue"("replacementItemId");

-- CreateIndex
CREATE INDEX "OrderIssue_orderId_status_idx" ON "OrderIssue"("orderId", "status");

-- CreateIndex
CREATE INDEX "OrderChatMessage_orderId_id_idx" ON "OrderChatMessage"("orderId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "OrderNotification_dedupeKey_key" ON "OrderNotification"("dedupeKey");

-- CreateIndex
CREATE INDEX "OrderNotification_orderId_status_idx" ON "OrderNotification"("orderId", "status");

-- AddForeignKey
ALTER TABLE "OrderIssue" ADD CONSTRAINT "OrderIssue_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderIssue" ADD CONSTRAINT "OrderIssue_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderIssue" ADD CONSTRAINT "OrderIssue_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderIssue" ADD CONSTRAINT "OrderIssue_proposedProductId_fkey" FOREIGN KEY ("proposedProductId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderIssue" ADD CONSTRAINT "OrderIssue_replacementItemId_fkey" FOREIGN KEY ("replacementItemId") REFERENCES "OrderItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderChatMessage" ADD CONSTRAINT "OrderChatMessage_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderChatMessage" ADD CONSTRAINT "OrderChatMessage_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "OrderIssue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderChatMessage" ADD CONSTRAINT "OrderChatMessage_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderNotification" ADD CONSTRAINT "OrderNotification_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderNotification" ADD CONSTRAINT "OrderNotification_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "OrderIssue"("id") ON DELETE SET NULL ON UPDATE CASCADE;


ALTER TABLE "ShopSettings" ADD CONSTRAINT "ShopSettings_response_minutes_check" CHECK ("customerResponseMinutes" BETWEEN 1 AND 120);
ALTER TABLE "OrderChatMessage" ADD COLUMN "recipient" TEXT NOT NULL DEFAULT 'both';
