ALTER TABLE "User" ADD COLUMN "orderPhone" TEXT;

CREATE TABLE "OrderPhone" (
    "id" SERIAL NOT NULL,
    "phone" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OrderPhone_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrderPhone_userId_phone_key" ON "OrderPhone"("userId", "phone");
CREATE INDEX "OrderPhone_userId_idx" ON "OrderPhone"("userId");
ALTER TABLE "OrderPhone" ADD CONSTRAINT "OrderPhone_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
