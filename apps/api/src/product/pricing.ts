import { BadRequestException } from '@nestjs/common';
import { goodsLine } from '../order/pricing.js';

export const SERVICE_MARKUP_PERCENT = 10;

// Product.price is always the seller's price in kopecks. Never persist this result there.
export function customerPrice(sellerPrice: number, percent = SERVICE_MARKUP_PERCENT) {
  if (!Number.isSafeInteger(percent) || percent < 0 || percent > 100)
    throw new BadRequestException('Некорректный процент сервисной наценки');
  return goodsLine(sellerPrice, 100 + percent, 100);
}

export function priceBreakdown(sellerPrice: number) {
  const price = customerPrice(sellerPrice);
  return { sellerPrice, serviceMarkupPercent: SERVICE_MARKUP_PERCENT,
    serviceMarkup: price - sellerPrice, customerPrice: price };
}
