CREATE TYPE "SaleModel" AS ENUM ('WEIGHT_LOOSE', 'PIECE_FIXED', 'BUNCH', 'PACK', 'WHOLE_VARIABLE_WEIGHT', 'CUT_TO_WEIGHT');
ALTER TABLE "Product"
  ADD COLUMN "saleModel" "SaleModel",
  ADD COLUMN "priceUnit" "Unit",
  ADD COLUMN "wholeLabel" VARCHAR(20),
  ADD COLUMN "estimatedWeightGrams" INTEGER;
ALTER TABLE "OrderItem"
  ADD COLUMN "saleModel" "SaleModel",
  ADD COLUMN "priceUnit" "Unit",
  ADD COLUMN "wholeLabel" VARCHAR(20),
  ADD COLUMN "estimatedWeightGrams" INTEGER,
  ADD COLUMN "weightMinGrams" INTEGER,
  ADD COLUMN "weightMaxGrams" INTEGER,
  ADD COLUMN "actualWeightGrams" INTEGER,
  ADD COLUMN "pieceWeights" JSONB,
  ALTER COLUMN "total" DROP NOT NULL;
ALTER TABLE "Order" ALTER COLUMN "subtotal" DROP NOT NULL;
ALTER TABLE "CartItem" ADD COLUMN "quantityUnit" "Unit", ADD COLUMN "weightMinGrams" INTEGER, ADD COLUMN "weightMaxGrams" INTEGER;
ALTER TABLE "OrderIssue"
  ADD COLUMN "approvedWeightGrams" INTEGER,
  ADD COLUMN "approvedPieceWeights" JSONB,
  ADD COLUMN "actualWeightGrams" INTEGER,
  ADD COLUMN "pieceWeights" JSONB,
  ADD COLUMN "proposedSaleModel" "SaleModel",
  ADD COLUMN "proposedPriceUnit" "Unit",
  ADD COLUMN "proposedWholeLabel" VARCHAR(20),
  ADD COLUMN "proposedEstimatedWeightGrams" INTEGER;
-- Additive migration only. Existing quantities, prices, totals and order snapshots are unchanged.
