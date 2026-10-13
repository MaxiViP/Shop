-- Add a derived sorting value; preserve existing prices, quantities and snapshots.
ALTER TABLE "Product" ADD COLUMN "normalizedPrice" DECIMAL(30,12)
  GENERATED ALWAYS AS (
    -- Match customerPrice()'s integer half-up rounding at SERVICE_MARKUP_PERCENT=10.
    -- Changing that fixed storefront markup requires updating this expression too.
    (("price"::bigint * 110 + 50) / 100)::numeric * CASE WHEN COALESCE("priceUnit", "unit") = 'GRAM'::"Unit" THEN 1000 ELSE 1 END
    / NULLIF("priceQty", 0)
  ) STORED NOT NULL;
CREATE INDEX "Product_normalizedPrice_name_id_idx" ON "Product"("normalizedPrice", "name", "id");
