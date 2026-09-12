import { BadRequestException } from '@nestjs/common';

export function checkoutLimits(
  type: 'DELIVERY' | 'PICKUP',
  subtotal: number,
  settings: {
    minDeliverySubtotal: number;
    deliveryEnabled: boolean;
    pickupEnabled: boolean;
  },
) {
  if (type === 'PICKUP') {
    if (!settings.pickupEnabled)
      throw new BadRequestException('Самовывоз временно недоступен.');
  } else {
    if (!settings.deliveryEnabled)
      throw new BadRequestException('Доставка временно недоступна.');
    if (subtotal < settings.minDeliverySubtotal)
      throw new BadRequestException(
        `Минимальная сумма товаров для доставки — ${settings.minDeliverySubtotal / 100} ₽.`,
      );
  }
}

export function extraLimits(
  unitPrice: number,
  amount: number,
  activeTotal: bigint,
  current: { unitPrice: number; amount: number } | null,
  settings: { maxOrderExtraUnitPrice: number; maxOrderExtrasTotal: number },
) {
  const next = activeTotal - BigInt(current?.amount ?? 0) + BigInt(amount);
  // A lowered policy must still allow corrections that strictly reduce a violation.
  if (
    unitPrice > settings.maxOrderExtraUnitPrice &&
    !(current && unitPrice < current.unitPrice)
  )
    throw new BadRequestException(
      `Максимальная цена услуги — ${settings.maxOrderExtraUnitPrice / 100} ₽.`,
    );
  if (
    next > BigInt(settings.maxOrderExtrasTotal) &&
    !(current && next < activeTotal)
  )
    throw new BadRequestException(
      `Максимальная сумма услуг — ${settings.maxOrderExtrasTotal / 100} ₽.`,
    );
}
