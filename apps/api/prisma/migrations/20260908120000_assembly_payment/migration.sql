-- Existing orders keep their monetary data. No historical payment is presumed paid.
ALTER TABLE "Order" ADD COLUMN "weightToleranceBps" INTEGER NOT NULL DEFAULT 1000,
  ADD COLUMN "assemblyFinalizedAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD CONSTRAINT "Order_tolerance_check" CHECK ("weightToleranceBps" BETWEEN 0 AND 5000);
CREATE TABLE "ShopSettings" (
  "id" INTEGER NOT NULL DEFAULT 1 PRIMARY KEY,
  "weightToleranceBps" INTEGER NOT NULL DEFAULT 1000,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "updatedById" INTEGER REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "ShopSettings_singleton" CHECK ("id" = 1),
  CONSTRAINT "ShopSettings_tolerance_check" CHECK ("weightToleranceBps" BETWEEN 0 AND 5000)
);
INSERT INTO "ShopSettings" ("id", "updatedAt") VALUES (1, CURRENT_TIMESTAMP);
CREATE TYPE "PaymentStatus" AS ENUM ('AWAITING', 'REPORTED', 'PAID', 'CANCELED');
CREATE TYPE "PaymentMethod" AS ENUM ('SBP', 'QR', 'CARD_TRANSFER');
CREATE TABLE "OrderPayment" (
  "id" SERIAL PRIMARY KEY,
  "orderId" INTEGER NOT NULL UNIQUE REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "amount" INTEGER NOT NULL CHECK ("amount" >= 0),
  "status" "PaymentStatus" NOT NULL DEFAULT 'AWAITING',
  "method" "PaymentMethod",
  "reportedAt" TIMESTAMP(3),
  "confirmedAt" TIMESTAMP(3),
  "confirmedById" INTEGER REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
