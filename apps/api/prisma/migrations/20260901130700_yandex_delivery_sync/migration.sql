-- AlterTable
ALTER TABLE "Delivery" ADD COLUMN     "providerStatus" TEXT,
ADD COLUMN     "providerUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "syncedAt" TIMESTAMP(3);
