-- Preserve every existing customer price/total. Only new pricing metadata is added.
ALTER TABLE "OrderItem" ADD COLUMN "serviceMarkupPercentSnapshot" INTEGER;
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_service_markup_check"
  CHECK ("serviceMarkupPercentSnapshot" IS NULL OR "serviceMarkupPercentSnapshot" BETWEEN 0 AND 100);

ALTER TABLE "OrderItemPriceChange" ADD COLUMN "sellerPrice" INTEGER;
ALTER TABLE "OrderItemPriceChange" ADD CONSTRAINT "OrderItemPriceChange_seller_price_check"
  CHECK ("sellerPrice" IS NULL OR "sellerPrice" BETWEEN 1 AND 100000000);
