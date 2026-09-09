import { BadRequestException } from '@nestjs/common';
import { lineAmount, sumAmounts } from './assembly.js';

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
  order: { subtotal: number; finalSubtotal: number | null },
  price: number,
) {
  positiveDeliveryPrice(price);
  return {
    deliveryPrice: price,
    total: totalWithDelivery(order.subtotal, price),
    finalTotal: totalWithDelivery(order.finalSubtotal, price),
  };
}
