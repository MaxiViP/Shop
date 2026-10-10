-- Additive: preserve automatic sales statistics, product relations and all existing templates.
CREATE TYPE "HitMode" AS ENUM ('AUTO', 'MANUAL', 'OFF');
CREATE TYPE "SeasonGroup" AS ENUM ('VEGETABLES', 'FRUITS', 'BERRIES');
ALTER TABLE "Product" ADD COLUMN "hitMode" "HitMode" NOT NULL DEFAULT 'AUTO';
CREATE INDEX "Product_active_hitMode_isHit_idx" ON "Product" (active, "hitMode", "isHit");
ALTER TABLE "SeasonTemplate"
  ADD COLUMN key VARCHAR(80),
  ADD COLUMN description VARCHAR(1000),
  ADD COLUMN "group" "SeasonGroup";
CREATE UNIQUE INDEX "SeasonTemplate_key_key" ON "SeasonTemplate" (key);
-- The explicit ADMIN preset action/seed adds missing templates without replacing edits.
