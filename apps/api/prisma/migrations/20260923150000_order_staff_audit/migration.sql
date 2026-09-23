-- Additive append-only actor audit for order staff mutations.
CREATE TABLE "OrderStaffAudit" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "role" "UserRole" NOT NULL,
    "action" VARCHAR(40) NOT NULL,
    "entityType" VARCHAR(20),
    "entityId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OrderStaffAudit_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OrderStaffAudit_orderId_createdAt_idx" ON "OrderStaffAudit"("orderId", "createdAt");
CREATE INDEX "OrderStaffAudit_userId_createdAt_idx" ON "OrderStaffAudit"("userId", "createdAt");
ALTER TABLE "OrderStaffAudit" ADD CONSTRAINT "OrderStaffAudit_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrderStaffAudit" ADD CONSTRAINT "OrderStaffAudit_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
