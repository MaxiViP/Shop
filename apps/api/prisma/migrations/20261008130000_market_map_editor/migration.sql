-- All existing anchors and hit areas remain unchanged: null dimensions use the original 80x92 SVG rect.
ALTER TABLE "MarketPoint"
  ADD COLUMN "mapWidth" DOUBLE PRECISION,
  ADD COLUMN "mapHeight" DOUBLE PRECISION,
  ADD COLUMN "mapColor" VARCHAR(7),
  ADD COLUMN "isOurPoint" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "ourLabel" VARCHAR(80);
ALTER TABLE "MarketPoint" ADD CONSTRAINT "MarketPoint_hit_size_check" CHECK (
  ("mapWidth" IS NULL AND "mapHeight" IS NULL)
  OR ("mapWidth" BETWEEN 12 AND 1200 AND "mapHeight" BETWEEN 12 AND 1460
    AND "mapWidth" IS NOT NULL AND "mapHeight" IS NOT NULL));
ALTER TABLE "MarketPoint" ADD CONSTRAINT "MarketPoint_color_check"
  CHECK ("mapColor" IS NULL OR "mapColor" ~ '^#[0-9A-Fa-f]{6}$');
ALTER TABLE "MarketPoint" ADD CONSTRAINT "MarketPoint_our_kind_check"
  CHECK (NOT "isOurPoint" OR "kind" NOT IN ('ENTRY', 'SERVICE'));
-- Prisma currently describes the rest of this table; this partial uniqueness rule is maintained here.
CREATE UNIQUE INDEX "MarketPoint_our_floor_key" ON "MarketPoint"("floor") WHERE "isOurPoint";

CREATE TABLE "MarketLayout" (
  "floor" INTEGER NOT NULL,
  "escalator" JSONB,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MarketLayout_pkey" PRIMARY KEY ("floor"),
  CONSTRAINT "MarketLayout_floor_check" CHECK ("floor" BETWEEN 1 AND 20),
  CONSTRAINT "MarketLayout_escalator_check" CHECK ("escalator" IS NULL OR jsonb_typeof("escalator") = 'object')
);
-- No shop is designated as ours and no new escalator location is inferred or seeded.
INSERT INTO "MarketLayout" ("floor", "updatedAt") VALUES (2, CURRENT_TIMESTAMP);
