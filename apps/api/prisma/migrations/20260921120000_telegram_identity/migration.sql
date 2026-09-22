-- Preserve all existing phones, users, orders and sessions.
ALTER TABLE "User" ALTER COLUMN "phone" DROP NOT NULL;
CREATE TABLE "TelegramIdentity" (
    "id" SERIAL NOT NULL,
    "telegramUserId" BIGINT NOT NULL,
    "username" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "userId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TelegramIdentity_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TelegramIdentity_telegramUserId_key" ON "TelegramIdentity"("telegramUserId");
CREATE UNIQUE INDEX "TelegramIdentity_userId_key" ON "TelegramIdentity"("userId");
ALTER TABLE "TelegramIdentity" ADD CONSTRAINT "TelegramIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE TABLE "TelegramAuthReplay" (
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TelegramAuthReplay_pkey" PRIMARY KEY ("tokenHash")
);
CREATE INDEX "TelegramAuthReplay_expiresAt_idx" ON "TelegramAuthReplay"("expiresAt");
