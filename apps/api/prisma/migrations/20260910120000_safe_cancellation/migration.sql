ALTER TABLE "OrderIssue" ADD COLUMN "suspendedResolution" "IssueResolution",
ADD COLUMN "suspendedResolvedAt" TIMESTAMP(3),
ADD COLUMN "suspendedStatus" "IssueStatus";

CREATE TABLE "OrderCancellation" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "fromStatus" "OrderStatus" NOT NULL,
    "paymentStatus" "PaymentStatus",
    "deliveryStatus" "DeliveryStatus",
    "reason" VARCHAR(1000),
    "canceledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "canceledById" INTEGER,
    "canceledByRole" "UserRole" NOT NULL,
    "restoredAt" TIMESTAMP(3),
    "restoredById" INTEGER,
    "restoredByRole" "UserRole",
    CONSTRAINT "OrderCancellation_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OrderCancellation_orderId_id_idx" ON "OrderCancellation"("orderId", "id");
ALTER TABLE "OrderCancellation" ADD CONSTRAINT "OrderCancellation_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderCancellation" ADD CONSTRAINT "OrderCancellation_canceledById_fkey" FOREIGN KEY ("canceledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OrderCancellation" ADD CONSTRAINT "OrderCancellation_restoredById_fkey" FOREIGN KEY ("restoredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- Legacy canceled orders intentionally receive no guessed history/fromStatus.
