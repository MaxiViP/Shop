BEGIN;

ALTER TABLE "Product" ADD COLUMN "portionQty" INTEGER;

-- Preserve every existing quantity configuration, including legacy min/step grids.
UPDATE "Product" SET "portionQty" = "min";

-- PostgreSQL verifies that no NULL remains before making the column required.
ALTER TABLE "Product" ALTER COLUMN "portionQty" SET NOT NULL;

COMMIT;
