-- Additive migration: existing order amounts, payments and the previous migrations are preserved.
CREATE TYPE "PromoDiscountType" AS ENUM ('FIXED', 'PERCENT');
CREATE TYPE "PromoStatus" AS ENUM ('AVAILABLE', 'USED', 'REVOKED');
CREATE TABLE "PromoCode" (
  "id" SERIAL NOT NULL, "code" VARCHAR(32) NOT NULL, "title" VARCHAR(160) NOT NULL,
  "userId" INTEGER NOT NULL, "type" "PromoDiscountType" NOT NULL,
  "amount" INTEGER, "percentBps" INTEGER, "maxDiscount" INTEGER,
  "minSubtotal" INTEGER NOT NULL DEFAULT 0, "expiresAt" TIMESTAMP(3) NOT NULL,
  "status" "PromoStatus" NOT NULL DEFAULT 'AVAILABLE', "reason" VARCHAR(1000) NOT NULL,
  "sourceOrderId" INTEGER, "issuedById" INTEGER NOT NULL, "revokedAt" TIMESTAMP(3),
  "usedAt" TIMESTAMP(3), "usedOrderId" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PromoCode_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PromoCode_terms_check" CHECK (
    "minSubtotal" >= 0 AND (
      ("type" = 'FIXED' AND "amount" IS NOT NULL AND "amount" > 0 AND "percentBps" IS NULL AND "maxDiscount" IS NULL) OR
      ("type" = 'PERCENT' AND "amount" IS NULL AND "percentBps" IS NOT NULL AND "percentBps" BETWEEN 1 AND 10000 AND "maxDiscount" IS NOT NULL AND "maxDiscount" > 0)
    )
  ),
  CONSTRAINT "PromoCode_usage_check" CHECK (
    ("status" = 'USED' AND "usedOrderId" IS NOT NULL AND "usedAt" IS NOT NULL) OR
    ("status" <> 'USED' AND "usedOrderId" IS NULL AND "usedAt" IS NULL)
  )
);
ALTER TABLE "Order"
  ADD COLUMN "promoCodeId" INTEGER,
  ADD COLUMN "promoCodeSnapshot" VARCHAR(32), ADD COLUMN "promoTitleSnapshot" VARCHAR(160),
  ADD COLUMN "promoTypeSnapshot" "PromoDiscountType", ADD COLUMN "promoAmountSnapshot" INTEGER,
  ADD COLUMN "promoPercentBpsSnapshot" INTEGER, ADD COLUMN "promoMaxDiscountSnapshot" INTEGER,
  ADD COLUMN "promoMinSubtotalSnapshot" INTEGER, ADD COLUMN "promoDiscount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "finalPromoDiscount" INTEGER;
ALTER TABLE "Order" ADD CONSTRAINT "Order_promo_discount_check"
  CHECK (("promoCodeId" IS NULL AND "promoDiscount" = 0 AND COALESCE("finalPromoDiscount", 0) = 0) OR
    ("promoDiscount" >= 0 AND "promoDiscount" <= subtotal AND
    ("finalPromoDiscount" IS NULL OR ("finalPromoDiscount" >= 0 AND "finalPromoDiscount" <= "finalSubtotal"))));
ALTER TABLE "Cart" ADD COLUMN "promoCodeId" INTEGER;
CREATE UNIQUE INDEX "PromoCode_code_key" ON "PromoCode"("code");
CREATE UNIQUE INDEX "PromoCode_usedOrderId_key" ON "PromoCode"("usedOrderId");
CREATE INDEX "PromoCode_userId_status_expiresAt_idx" ON "PromoCode"("userId", "status", "expiresAt");
CREATE INDEX "PromoCode_sourceOrderId_idx" ON "PromoCode"("sourceOrderId");
CREATE INDEX "Order_promoCodeId_idx" ON "Order"("promoCodeId");
ALTER TABLE "PromoCode" ADD CONSTRAINT "PromoCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PromoCode" ADD CONSTRAINT "PromoCode_issuedById_fkey" FOREIGN KEY ("issuedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PromoCode" ADD CONSTRAINT "PromoCode_sourceOrderId_fkey" FOREIGN KEY ("sourceOrderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PromoCode" ADD CONSTRAINT "PromoCode_usedOrderId_fkey" FOREIGN KEY ("usedOrderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_promoCodeId_fkey" FOREIGN KEY ("promoCodeId") REFERENCES "PromoCode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Cart" ADD CONSTRAINT "Cart_promoCodeId_fkey" FOREIGN KEY ("promoCodeId") REFERENCES "PromoCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;
