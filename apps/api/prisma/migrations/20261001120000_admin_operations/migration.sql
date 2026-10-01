CREATE TYPE "SettlementMode" AS ENUM ('UNSET', 'SHARED_MARKUP', 'NO_MARKUP');

ALTER TABLE "Product"
  ADD COLUMN "settlementMode" "SettlementMode" NOT NULL DEFAULT 'UNSET',
  ADD COLUMN "basePrice" INTEGER;
ALTER TABLE "Product" ADD CONSTRAINT "Product_settlement_check"
  CHECK (("settlementMode" = 'SHARED_MARKUP' AND "basePrice" IS NOT NULL AND "basePrice" BETWEEN 1 AND 100000000)
    OR ("settlementMode" <> 'SHARED_MARKUP' AND "basePrice" IS NULL));
CREATE INDEX "Product_settlementMode_idx" ON "Product"("settlementMode");

ALTER TABLE "OrderItem"
  ADD COLUMN "settlementModeSnapshot" "SettlementMode",
  ADD COLUMN "basePriceSnapshot" INTEGER;
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_settlement_snapshot_check"
  CHECK (("settlementModeSnapshot" IS NULL AND "basePriceSnapshot" IS NULL)
    OR ("settlementModeSnapshot" = 'SHARED_MARKUP' AND "basePriceSnapshot" IS NOT NULL AND "basePriceSnapshot" BETWEEN 1 AND 100000000)
    OR ("settlementModeSnapshot" IN ('UNSET', 'NO_MARKUP') AND "basePriceSnapshot" IS NULL));

ALTER TABLE "Order" ADD COLUMN "completedAt" TIMESTAMP(3);
CREATE INDEX "Order_status_completedAt_idx" ON "Order"("status", "completedAt");

ALTER TABLE "ShopSettings"
  ADD COLUMN "partner1Name" VARCHAR(80) NOT NULL DEFAULT 'Партнёр 1',
  ADD COLUMN "partner2Name" VARCHAR(80) NOT NULL DEFAULT 'Партнёр 2';
ALTER TABLE "ShopSettings" ADD CONSTRAINT "ShopSettings_partner_names_check"
  CHECK (length(btrim("partner1Name")) BETWEEN 1 AND 80
    AND length(btrim("partner2Name")) BETWEEN 1 AND 80);

CREATE TABLE "ShopHours" (
  "weekday" INTEGER NOT NULL PRIMARY KEY,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "openMinutes" INTEGER NOT NULL DEFAULT 540,
  "closeMinutes" INTEGER NOT NULL DEFAULT 1260,
  CONSTRAINT "ShopHours_weekday_check" CHECK ("weekday" BETWEEN 1 AND 7),
  CONSTRAINT "ShopHours_times_check" CHECK ("openMinutes" >= 0 AND "openMinutes" < "closeMinutes" AND "closeMinutes" <= 1440)
);
INSERT INTO "ShopHours" ("weekday", "enabled", "openMinutes", "closeMinutes")
  SELECT day, true, 540, 1260 FROM generate_series(1, 7) AS day;

CREATE TABLE "ShopHoursException" (
  "id" SERIAL NOT NULL PRIMARY KEY,
  "date" DATE NOT NULL,
  "closed" BOOLEAN NOT NULL DEFAULT false,
  "openMinutes" INTEGER,
  "closeMinutes" INTEGER,
  "note" VARCHAR(160),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ShopHoursException_times_check" CHECK (
    ("closed" AND "openMinutes" IS NULL AND "closeMinutes" IS NULL) OR
    (NOT "closed" AND "openMinutes" IS NOT NULL AND "closeMinutes" IS NOT NULL AND "openMinutes" >= 0 AND "openMinutes" < "closeMinutes" AND "closeMinutes" <= 1440)
  )
);
CREATE UNIQUE INDEX "ShopHoursException_date_key" ON "ShopHoursException"("date");

CREATE TABLE "PartnerPayout" (
  "id" SERIAL NOT NULL PRIMARY KEY,
  "partner" INTEGER NOT NULL,
  "periodFrom" DATE NOT NULL,
  "periodTo" DATE NOT NULL,
  "amount" INTEGER NOT NULL,
  "paidAt" TIMESTAMP(3) NOT NULL,
  "comment" VARCHAR(500),
  "idempotencyKey" UUID NOT NULL,
  "createdById" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PartnerPayout_partner_check" CHECK ("partner" IN (1, 2)),
  CONSTRAINT "PartnerPayout_period_check" CHECK ("periodFrom" <= "periodTo"),
  CONSTRAINT "PartnerPayout_amount_check" CHECK ("amount" <> 0),
  CONSTRAINT "PartnerPayout_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PartnerPayout_idempotencyKey_key" ON "PartnerPayout"("idempotencyKey");
CREATE INDEX "PartnerPayout_periodFrom_periodTo_idx" ON "PartnerPayout"("periodFrom", "periodTo");
CREATE INDEX "PartnerPayout_paidAt_idx" ON "PartnerPayout"("paidAt");

CREATE TABLE "AdminAudit" (
  "id" SERIAL NOT NULL PRIMARY KEY,
  "actorId" INTEGER NOT NULL,
  "action" VARCHAR(48) NOT NULL,
  "entity" VARCHAR(48) NOT NULL,
  "entityId" VARCHAR(80) NOT NULL,
  "oldValue" JSONB,
  "newValue" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdminAudit_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "AdminAudit_entity_entityId_createdAt_idx" ON "AdminAudit"("entity", "entityId", "createdAt");
CREATE INDEX "AdminAudit_actorId_createdAt_idx" ON "AdminAudit"("actorId", "createdAt");
