-- Keep one visible chat message while retaining each physical image until its lifecycle ends.
ALTER TABLE "Order" ADD COLUMN "customerReadImageRevisionId" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Order" ADD COLUMN "staffReadImageRevisionId" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Order" ADD CONSTRAINT "Order_customerReadImageRevisionId_check" CHECK ("customerReadImageRevisionId" >= 0);
ALTER TABLE "Order" ADD CONSTRAINT "Order_staffReadImageRevisionId_check" CHECK ("staffReadImageRevisionId" >= 0);

ALTER TABLE "OrderChatMessage" ADD COLUMN "imageRevision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "OrderChatMessage" ADD CONSTRAINT "OrderChatMessage_imageRevision_check" CHECK ("imageRevision" >= 0);

CREATE TABLE "OrderChatImageRevision" (
  "id" SERIAL NOT NULL,
  "messageId" INTEGER NOT NULL,
  "version" INTEGER NOT NULL,
  "imageKey" UUID NOT NULL,
  "requestId" UUID,
  "actorType" "MessageAuthor" NOT NULL,
  "actorUserId" INTEGER,
  "caption" VARCHAR(2000) NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderChatImageRevision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OrderChatImageRevision_version_check" CHECK ("version" >= 0)
);
CREATE UNIQUE INDEX "OrderChatImageRevision_imageKey_key" ON "OrderChatImageRevision"("imageKey");
CREATE UNIQUE INDEX "OrderChatImageRevision_messageId_version_key" ON "OrderChatImageRevision"("messageId", "version");
CREATE UNIQUE INDEX "OrderChatImageRevision_messageId_requestId_key" ON "OrderChatImageRevision"("messageId", "requestId");
CREATE INDEX "OrderChatImageRevision_messageId_createdAt_idx" ON "OrderChatImageRevision"("messageId", "createdAt");
ALTER TABLE "OrderChatImageRevision" ADD CONSTRAINT "OrderChatImageRevision_messageId_fkey"
  FOREIGN KEY ("messageId") REFERENCES "OrderChatMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderChatImageRevision" ADD CONSTRAINT "OrderChatImageRevision_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Production already has images from the applied chat migration. Preserve them as version zero.
INSERT INTO "OrderChatImageRevision" ("messageId", "version", "imageKey", "requestId", "actorType", "actorUserId", "createdAt")
SELECT "id", 0, "imageKey", "imageRequestId", "authorType", "authorUserId", "createdAt"
FROM "OrderChatMessage" WHERE "imageKey" IS NOT NULL;
