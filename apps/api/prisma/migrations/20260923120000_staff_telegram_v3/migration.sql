-- Staff bot identity and short-lived, single-use state. Existing users and orders are unchanged.
CREATE TABLE "StaffTelegramIdentity" (
    "id" SERIAL NOT NULL,
    "telegramUserId" BIGINT NOT NULL,
    "userId" INTEGER NOT NULL,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "botStartedAt" TIMESTAMP(3),
    "blockedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StaffTelegramIdentity_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StaffTelegramIdentity_telegramUserId_key" ON "StaffTelegramIdentity"("telegramUserId");
CREATE UNIQUE INDEX "StaffTelegramIdentity_userId_key" ON "StaffTelegramIdentity"("userId");
ALTER TABLE "StaffTelegramIdentity" ADD CONSTRAINT "StaffTelegramIdentity_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "StaffTelegramLinkCode" (
    "codeHash" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StaffTelegramLinkCode_pkey" PRIMARY KEY ("codeHash")
);
CREATE UNIQUE INDEX "StaffTelegramLinkCode_userId_key" ON "StaffTelegramLinkCode"("userId");
CREATE INDEX "StaffTelegramLinkCode_expiresAt_idx" ON "StaffTelegramLinkCode"("expiresAt");
ALTER TABLE "StaffTelegramLinkCode" ADD CONSTRAINT "StaffTelegramLinkCode_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "StaffTelegramSession" (
    "identityId" INTEGER NOT NULL,
    "action" VARCHAR(32) NOT NULL,
    "step" VARCHAR(32) NOT NULL,
    "orderId" INTEGER NOT NULL,
    "itemId" INTEGER,
    "promptMessageId" INTEGER,
    "dashboardMessageId" INTEGER,
    "confirmationCode" VARCHAR(16),
    "payload" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StaffTelegramSession_pkey" PRIMARY KEY ("identityId")
);
CREATE INDEX "StaffTelegramSession_expiresAt_idx" ON "StaffTelegramSession"("expiresAt");
ALTER TABLE "StaffTelegramSession" ADD CONSTRAINT "StaffTelegramSession_identityId_fkey"
    FOREIGN KEY ("identityId") REFERENCES "StaffTelegramIdentity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
