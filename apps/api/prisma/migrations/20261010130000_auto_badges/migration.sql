-- Complements home_content; no existing prices, order snapshots or images change.
CREATE TYPE "SeasonalMode" AS ENUM ('AUTO', 'MANUAL', 'OFF');
CREATE TABLE "SeasonTemplate" (
  id SERIAL PRIMARY KEY,
  name VARCHAR(160) NOT NULL,
  "startMonth" INTEGER NOT NULL,
  "endMonth" INTEGER NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SeasonTemplate_months_check" CHECK ("startMonth" BETWEEN 1 AND 12 AND "endMonth" BETWEEN 1 AND 12)
);
ALTER TABLE "Product"
  ADD COLUMN "seasonalMode" "SeasonalMode" NOT NULL DEFAULT 'OFF',
  ADD COLUMN "seasonTemplateId" INTEGER,
  ADD COLUMN "hitOrders" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "hitSoldUnits" DECIMAL(24,3) NOT NULL DEFAULT 0,
  ADD COLUMN "hitRank" INTEGER;
-- Preserve any manual season designation made before this extension.
UPDATE "Product" SET "seasonalMode" = 'MANUAL' WHERE "isSeasonal";
ALTER TABLE "Product" ADD CONSTRAINT "Product_seasonTemplateId_fkey"
  FOREIGN KEY ("seasonTemplateId") REFERENCES "SeasonTemplate"(id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Product" ADD CONSTRAINT "Product_auto_season_check"
  CHECK ("seasonalMode" <> 'AUTO' OR "seasonTemplateId" IS NOT NULL);
ALTER TABLE "Product" ADD CONSTRAINT "Product_hit_stats_check"
  CHECK ("hitOrders" >= 0 AND "hitSoldUnits" >= 0 AND ("hitRank" IS NULL OR "hitRank" > 0));
CREATE INDEX "Product_seasonTemplateId_idx" ON "Product"("seasonTemplateId");
CREATE INDEX "Product_seasonalMode_active_idx" ON "Product"("seasonalMode", active);

ALTER TABLE "ShopSettings"
  ADD COLUMN "hitPeriodDays" INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN "hitMinOrders" INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN "hitShareBps" INTEGER NOT NULL DEFAULT 1500,
  ADD COLUMN "hitLastCalculatedAt" TIMESTAMP(3);
ALTER TABLE "ShopSettings" ADD CONSTRAINT "ShopSettings_hit_rule_check"
  CHECK ("hitPeriodDays" BETWEEN 1 AND 365 AND "hitMinOrders" BETWEEN 1 AND 1000000 AND "hitShareBps" BETWEEN 1 AND 10000);
-- Templates and sales statistics are intentionally not seeded.
