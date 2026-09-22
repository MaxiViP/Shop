-- Customer bot activation is opt-in. Existing identities remain inactive.
ALTER TABLE "TelegramIdentity"
    ADD COLUMN "customerBotStartedAt" TIMESTAMP(3),
    ADD COLUMN "customerBotBlockedAt" TIMESTAMP(3);
