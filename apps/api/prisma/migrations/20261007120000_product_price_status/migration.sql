-- Price provenance is metadata only: seller prices and order snapshots stay intact.
CREATE TYPE "ProductPriceStatus" AS ENUM ('ESTIMATED', 'SOURCE', 'AUDITED');
ALTER TABLE "Product" ADD COLUMN "priceStatus" "ProductPriceStatus" NOT NULL DEFAULT 'ESTIMATED';
CREATE INDEX "Product_priceStatus_idx" ON "Product"("priceStatus");

-- These two dated, version-controlled imports used published seller prices.
UPDATE "Product" AS product SET "priceStatus" = 'SOURCE'
FROM "MarketPoint" AS point
WHERE product."marketPointId" = point.id AND product."sourceCheckedAt" IS NOT NULL
  AND ((point.slug = 'cezoni-market' AND product."sourceUrl" = 'https://cezoni.com/collection/all')
    OR (point.slug = 'grand-bazar' AND product."sourceUrl" = 'https://grandbazar.su/shop/'));

-- A known seller can have a catalog page before its location is physically audited.
ALTER TABLE "MarketPoint" ALTER COLUMN "mapX" DROP NOT NULL, ALTER COLUMN "mapY" DROP NOT NULL;
ALTER TABLE "MarketPoint" ADD CONSTRAINT "MarketPoint_position_pair_check"
  CHECK (("mapX" IS NULL AND "mapY" IS NULL) OR ("mapX" IS NOT NULL AND "mapY" IS NOT NULL));
