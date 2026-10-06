-- Seller prices and existing order snapshots remain unchanged.
ALTER TABLE "Product"
  ADD COLUMN "marketPointId" INTEGER,
  ADD COLUMN "sourceUrl" TEXT,
  ADD COLUMN "sourceCheckedAt" TIMESTAMP(3);

CREATE INDEX "Product_marketPointId_idx" ON "Product"("marketPointId");

ALTER TABLE "Product" ADD CONSTRAINT "Product_marketPointId_fkey"
  FOREIGN KEY ("marketPointId") REFERENCES "MarketPoint"("id") ON DELETE SET NULL ON UPDATE CASCADE;
