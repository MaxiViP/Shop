-- Add optional profile metadata without changing identity, users or sessions.
ALTER TABLE "TelegramIdentity"
    ADD COLUMN "photoUrl" TEXT,
    ADD COLUMN "phoneNumber" TEXT,
    ADD COLUMN "phoneVerified" BOOLEAN NOT NULL DEFAULT false;
