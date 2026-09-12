export interface PublicShopSettings {
  minDeliverySubtotal: number;
  deliveryEnabled: boolean;
  pickupEnabled: boolean;
}
export interface ExtraLimits {
  maxOrderExtraUnitPrice: number;
  maxOrderExtrasTotal: number;
}
export function deliveryEligibility(
  subtotal: number,
  settings: PublicShopSettings,
) {
  const remaining = Math.max(0, settings.minDeliverySubtotal - subtotal);
  return {
    remaining,
    progress:
      settings.minDeliverySubtotal === 0
        ? 100
        : Math.min(
            100,
            Math.max(0, (subtotal / settings.minDeliverySubtotal) * 100),
          ),
    delivery: settings.deliveryEnabled && remaining === 0,
    pickup: settings.pickupEnabled,
  };
}
export function extraLimitError(
  price: number,
  amount: number,
  activeTotal: number,
  current: { unitPrice: number; amount: number } | undefined,
  limits: ExtraLimits,
) {
  if (
    price > limits.maxOrderExtraUnitPrice &&
    !(current && price < current.unitPrice)
  )
    return "Превышена максимальная цена услуги";
  const next = activeTotal - (current?.amount ?? 0) + amount;
  if (next > limits.maxOrderExtrasTotal && !(current && next < activeTotal))
    return "Превышена максимальная сумма услуг";
  return "";
}
