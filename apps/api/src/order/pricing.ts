import { BadRequestException } from '@nestjs/common';
import { lineAmount, sumAmounts } from './assembly.js';
import { payableGoods } from '../promo/promo.js';
import { actualQuantity, estimatedQuantity, type Sale, type WeighedItem } from '../product/sale.js';

export function requestedLine(item: Sale & { price: number; priceQty: number; qty: number }): number | null {
  try {
    const qty = estimatedQuantity(item, item.qty);
    return qty === null ? null : goodsLine(item.price, qty, item.priceQty);
  } catch (error) {
    if (error instanceof RangeError) throw new BadRequestException(error.message);
    throw error;
  }
}
export function pickedLine(item: WeighedItem & { price: number; actualPrice?: number | null; priceQty: number }): number {
  try { return goodsLine(item.actualPrice ?? item.price, actualQuantity(item), item.priceQty); }
  catch (error) {
    if (error instanceof RangeError) throw new BadRequestException(error.message);
    throw error;
  }
}

export function goodsLine(price: number, qty: number, priceQty: number) {
  try {
    return lineAmount(price, qty, priceQty);
  } catch (error) {
    if (error instanceof RangeError)
      throw new BadRequestException(error.message);
    throw error;
  }
}
export function goodsSum(values: number[]) {
  try {
    return sumAmounts(values);
  } catch (error) {
    if (error instanceof RangeError)
      throw new BadRequestException(error.message);
    throw error;
  }
}

const maxMoney = 2_147_483_647;

export function positiveDeliveryPrice(price: unknown): asserts price is number {
  if (
    typeof price !== 'number' ||
    !Number.isSafeInteger(price) ||
    price <= 0 ||
    price > maxMoney
  ) {
    throw new BadRequestException(
      'Укажите положительную стоимость доставки в целых копейках',
    );
  }
}

export function totalWithDelivery(
  subtotal: number | null,
  price: number | null,
) {
  if (subtotal === null || price === null) return null;
  const total = subtotal + price;
  if (!Number.isSafeInteger(total) || total < 0 || total > maxMoney) {
    throw new BadRequestException(
      'Сумма заказа превышает допустимую стоимость',
    );
  }
  return total;
}

// Apply together with Delivery.price in a transaction holding the Order row lock.
export function deliveryTotals(
  order: { subtotal: number | null; finalSubtotal: number | null; freeDeliveryApplied?: boolean; promoDiscount?: number; finalPromoDiscount?: number | null },
  price: number,
) {
  positiveDeliveryPrice(price);
  const customerPrice = order.freeDeliveryApplied ? 0 : price;
  return {
    deliveryPrice: customerPrice,
    total: totalWithDelivery(order.subtotal === null ? null : order.subtotal - (order.promoDiscount ?? 0), customerPrice),
    finalTotal: totalWithDelivery(payableGoods(order), customerPrice),
  };
}
