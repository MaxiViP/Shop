CREATE TYPE "ExtraStatus" AS ENUM ('ACTIVE', 'CANCELED');

CREATE TABLE "OrderExtra" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "comment" VARCHAR(1000),
    "quantity" INTEGER NOT NULL,
    "unitPrice" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" "ExtraStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "canceledAt" TIMESTAMP(3),
    CONSTRAINT "OrderExtra_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OrderExtra_orderId_status_idx" ON "OrderExtra"("orderId", "status");
ALTER TABLE "OrderExtra" ADD CONSTRAINT "OrderExtra_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderExtra" ADD CONSTRAINT "OrderExtra_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
