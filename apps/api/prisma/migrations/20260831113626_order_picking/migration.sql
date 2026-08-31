-- CreateEnum
CREATE TYPE "OrderItemStatus" AS ENUM ('PENDING', 'PICKED', 'MISSING');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "finalSubtotal" INTEGER,
ADD COLUMN     "finalTotal" INTEGER;

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "actualTotal" INTEGER,
ADD COLUMN     "status" "OrderItemStatus" NOT NULL DEFAULT 'PENDING';
