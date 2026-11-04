import { BadRequestException } from '@nestjs/common';
import { goodsLine } from '../order/pricing.js';

export const SERVICE_MARKUP_PERCENT = 10;

export function effectivePercent(override: number | null, globalPercent: number) {
  for (const percent of [globalPercent, ...(override === null ? [] : [override])])
    if (!Number.isSafeInteger(percent) || percent < 0 || percent > 100)
      throw new BadRequestException('Некорректный процент сервисной наценки');
  return override ?? globalPercent;
}

// Product.price is always the seller's price in kopecks. Never persist this result there.
export function customerPrice(sellerPrice: number, percent = SERVICE_MARKUP_PERCENT) {
  return goodsLine(sellerPrice, 100 + effectivePercent(percent, SERVICE_MARKUP_PERCENT), 100);
}

export function priceBreakdown(sellerPrice: number, percent = SERVICE_MARKUP_PERCENT) {
  const price = customerPrice(sellerPrice, percent);
  return { sellerPrice, serviceMarkupPercent: percent,
    serviceMarkup: price - sellerPrice, customerPrice: price };
}
