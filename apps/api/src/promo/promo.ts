import { BadRequestException } from '@nestjs/common';
export type PromoTerms = {
  type: 'FIXED' | 'PERCENT'; amount: number | null; percentBps: number | null;
  maxDiscount: number | null; minSubtotal: number;
};
// Round once, half up, in integer kopecks; delivery and extras are outside the base.
export function discountAmount(goods: number, terms: PromoTerms) {
  if (!Number.isSafeInteger(goods) || goods < 0 || goods > 2_147_483_647)
    throw new BadRequestException('Некорректная стоимость товаров');
  const discount = terms.type === 'FIXED' ? terms.amount ?? 0
    : Number((BigInt(goods) * BigInt(terms.percentBps ?? 0) + 5000n) / 10000n);
  return Math.min(goods, discount, terms.maxDiscount ?? goods);
}
export type DiscountedOrder = {
  subtotal?: number; finalSubtotal: number | null; promoDiscount?: number; finalPromoDiscount?: number | null;
};
export function payableGoods(order: DiscountedOrder) {
  return order.finalSubtotal === null ? null
    : Math.max(0, order.finalSubtotal - (order.finalPromoDiscount ?? order.promoDiscount ?? 0));
}
export type PromoSnapshot = {
  promoTypeSnapshot?: 'FIXED' | 'PERCENT' | null; promoAmountSnapshot?: number | null;
  promoPercentBpsSnapshot?: number | null; promoMaxDiscountSnapshot?: number | null;
};
export function assembledDiscount(order: PromoSnapshot, goods: number) {
  return order.promoTypeSnapshot ? discountAmount(goods, {
    type: order.promoTypeSnapshot, amount: order.promoAmountSnapshot ?? null,
    percentBps: order.promoPercentBpsSnapshot ?? null, maxDiscount: order.promoMaxDiscountSnapshot ?? null, minSubtotal: 0,
  }) : 0;
}
export const promoOrderSelect = {
  promoCodeSnapshot: true, promoTitleSnapshot: true, promoDiscount: true, finalPromoDiscount: true,
} as const;
