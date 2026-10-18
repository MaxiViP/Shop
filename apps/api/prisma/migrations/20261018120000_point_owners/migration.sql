ALTER TABLE "MarketPoint" ADD COLUMN "cardColor" VARCHAR(7);
ALTER TABLE "MarketPoint" ADD CONSTRAINT "MarketPoint_card_color_check"
  CHECK ("cardColor" IS NULL OR "cardColor" ~ '^#[0-9A-Fa-f]{6}$');
CREATE TABLE "MarketPointOwner" (
  "userId" INTEGER NOT NULL,
  "marketPointId" INTEGER NOT NULL,
  CONSTRAINT "MarketPointOwner_pkey" PRIMARY KEY ("userId", "marketPointId"),
  CONSTRAINT "MarketPointOwner_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "MarketPointOwner_marketPointId_fkey" FOREIGN KEY ("marketPointId") REFERENCES "MarketPoint"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "MarketPointOwner_marketPointId_idx" ON "MarketPointOwner"("marketPointId");
-- Preserve prices, orders, images and existing map coordinates.
INSERT INTO "MarketPoint" ("slug", "name", "kind", "floor", "isOurPoint", "isPublished", "sortOrder", "cardColor", "updatedAt")
SELECT 'our-vegetables-fruits', 'Наша точка «Овощи и фрукты»', 'STALL', 2, true, true, -1, '#00FF00', CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM "MarketPoint" WHERE "isOurPoint")
ON CONFLICT ("slug") DO NOTHING;
UPDATE "MarketPoint" SET "cardColor" = '#00FF00', "isPublished" = true, "name" = 'Наша точка «Овощи и фрукты»', "updatedAt" = CURRENT_TIMESTAMP
WHERE id = (SELECT id FROM "MarketPoint" WHERE "isOurPoint" ORDER BY (floor = 2) DESC, id LIMIT 1);
-- The shop owner requested all vegetables, fruits, herbs and berries, including subcategories.
WITH RECURSIVE assortment AS (
  SELECT id FROM "Category" WHERE slug IN ('vegetables', 'fruits', 'greens', 'berries')
  UNION ALL SELECT c.id FROM "Category" c JOIN assortment a ON c."parentId" = a.id
)
UPDATE "Product" SET "marketPointId" = (
  SELECT id FROM "MarketPoint" WHERE "isOurPoint" ORDER BY (floor = 2) DESC, id LIMIT 1
), "updatedAt" = CURRENT_TIMESTAMP
WHERE "categoryId" IN (SELECT id FROM assortment);

-- The old markup was fixed at 10%; existing customer prices are preserved.
ALTER TABLE "Product" ADD COLUMN "serviceMarkupPercent" INTEGER NOT NULL DEFAULT 10;
ALTER TABLE "Product" ADD CONSTRAINT "Product_markup_check" CHECK ("serviceMarkupPercent" BETWEEN 0 AND 100);
-- Rebuild only the derived sorting value. Source prices and order snapshots are retained.
DROP INDEX "Product_normalizedPrice_name_id_idx";
ALTER TABLE "Product" DROP COLUMN "normalizedPrice";
ALTER TABLE "Product" ADD COLUMN "normalizedPrice" DECIMAL(30,12) GENERATED ALWAYS AS (
  (("price"::bigint * (100 + "serviceMarkupPercent") + 50) / 100)::numeric
  * CASE WHEN COALESCE("priceUnit", "unit") = 'GRAM'::"Unit" THEN 1000 ELSE 1 END / NULLIF("priceQty", 0)
) STORED NOT NULL;
CREATE INDEX "Product_normalizedPrice_name_id_idx" ON "Product"("normalizedPrice", "name", "id");
