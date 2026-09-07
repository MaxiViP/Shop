-- Unknown delivery cost is distinct from a genuinely free pickup.
-- Preserve all existing values, including historical zeroes.
ALTER TABLE "Order"
    ALTER COLUMN "deliveryPrice" DROP NOT NULL,
    ALTER COLUMN "deliveryPrice" DROP DEFAULT,
    ALTER COLUMN "total" DROP NOT NULL;
