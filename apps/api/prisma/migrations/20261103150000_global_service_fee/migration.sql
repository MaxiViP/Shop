BEGIN;

-- Fail rather than wait indefinitely on a live checkout. No runtime policy is enabled here.
SET LOCAL lock_timeout = '5s';
LOCK TABLE "ShopSettings", "Product" IN ACCESS EXCLUSIVE MODE;

-- Validate under the same locks as the backfill, even if an old constraint was removed locally.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "Product"
    WHERE "serviceMarkupPercent" IS NULL OR "serviceMarkupPercent" NOT BETWEEN 0 AND 100
  ) THEN
    RAISE EXCEPTION 'Invalid Product.serviceMarkupPercent; migration aborted without changing prices';
  END IF;
END $$;

ALTER TABLE "ShopSettings"
  ADD COLUMN "globalServiceMarkupPercent" INTEGER NOT NULL DEFAULT 10,
  ADD CONSTRAINT "ShopSettings_global_service_markup_check"
    CHECK ("globalServiceMarkupPercent" BETWEEN 0 AND 100);

ALTER TABLE "Product"
  ADD COLUMN "serviceMarkupPercentOverride" INTEGER,
  ADD COLUMN "serviceMarkupNeedsReview" BOOLEAN NOT NULL DEFAULT false,
  ADD CONSTRAINT "Product_service_markup_override_check"
    CHECK ("serviceMarkupPercentOverride" IS NULL OR "serviceMarkupPercentOverride" BETWEEN 0 AND 100);

-- Preserve every existing effective percentage, including intentional zero.
-- The legacy default, create form and incomplete audit cannot prove the origin of 10%.
-- Conservatively review all existing 10% values; review does not change their price or mode.
UPDATE "Product"
SET "serviceMarkupPercentOverride" = "serviceMarkupPercent",
    "serviceMarkupNeedsReview" = ("serviceMarkupPercent" = 10);

-- No changes to effective percentages, seller prices, generated column definitions or order history.
COMMIT;
