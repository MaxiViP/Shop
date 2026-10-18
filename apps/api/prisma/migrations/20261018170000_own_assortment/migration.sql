-- Production categories use transliterated slugs; keep the original aliases too.
-- Only product ownership changes. Prices, images and order snapshots are retained.
WITH RECURSIVE assortment AS (
  SELECT id FROM "Category"
  WHERE slug IN ('vegetables', 'fruits', 'greens', 'berries', 'ovoschi', 'frukty', 'zelen')
  UNION ALL
  SELECT c.id FROM "Category" c JOIN assortment a ON c."parentId" = a.id
), our_point AS (
  SELECT id FROM "MarketPoint" WHERE "isOurPoint"
  ORDER BY (floor = 2) DESC, id LIMIT 1
)
UPDATE "Product" p
SET "marketPointId" = point.id, "updatedAt" = CURRENT_TIMESTAMP
FROM our_point point
WHERE p."categoryId" IN (SELECT id FROM assortment)
  AND p."marketPointId" IS DISTINCT FROM point.id;
