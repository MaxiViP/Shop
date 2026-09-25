BEGIN;

CREATE TABLE "Cart" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "revision" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Cart_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "CartItem" (
    "cartId" INTEGER NOT NULL,
    "productId" INTEGER NOT NULL,
    "qty" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CartItem_pkey" PRIMARY KEY ("cartId", "productId"),
    CONSTRAINT "CartItem_qty_check" CHECK ("qty" > 0 AND "qty" <= 1000000)
);
CREATE UNIQUE INDEX "Cart_userId_key" ON "Cart"("userId");
CREATE INDEX "CartItem_productId_idx" ON "CartItem"("productId");
ALTER TABLE "Cart" ADD CONSTRAINT "Cart_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CartItem" ADD CONSTRAINT "CartItem_cartId_fkey"
    FOREIGN KEY ("cartId") REFERENCES "Cart"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CartItem" ADD CONSTRAINT "CartItem_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CHAT keeps its existing owned-order FK. CHECKOUT has no order until commit.
ALTER TABLE "CustomerTelegramSession" ALTER COLUMN "orderId" DROP NOT NULL;
ALTER TABLE "CustomerTelegramSession" ADD COLUMN "payload" JSONB;

-- Widening orderId must not allow CHAT without an order, or CHECKOUT attached to one.
-- Full checkout draft validation and order ownership remain domain checks.
ALTER TABLE "CustomerTelegramSession"
    ADD CONSTRAINT "CustomerTelegramSession_state_check" CHECK (
        ("promptMessageId" IS NULL OR "promptMessageId" > 0)
        AND (
            ("action" = 'CHAT' AND "orderId" IS NOT NULL AND "payload" IS NULL
                AND (("step" = 'PROMPT' AND "promptMessageId" IS NULL)
                    OR ("step" = 'TEXT' AND "promptMessageId" IS NOT NULL)))
            OR
            ("action" = 'CHECKOUT' AND "orderId" IS NULL
                AND "payload" IS NOT NULL AND jsonb_typeof("payload") = 'object'
                AND (("step" IN ('TYPE', 'ADDRESS', 'CONFIRM') AND "promptMessageId" IS NULL)
                    OR "step" IN ('NAME', 'PHONE', 'CITY', 'STREET', 'HOUSE', 'FLAT',
                        'ENTRANCE', 'FLOOR', 'INTERCOM', 'COMMENT', 'TIME')))
        )
    );

COMMIT;
