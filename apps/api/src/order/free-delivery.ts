import { totalWithDelivery } from './pricing.js';

type DeliverySettings = {
  deliveryEnabled: boolean;
  freeDeliveryEnabled: boolean;
  freeDeliveryThreshold: number | null;
};

// The subtotal contains backend customer prices, after any applicable discounts.
// Carrier fees and extra services must never contribute to this threshold.
export function freeDelivery(subtotal: number | null, settings: DeliverySettings) {
  const threshold = settings.freeDeliveryThreshold;
  const enabled = settings.deliveryEnabled && settings.freeDeliveryEnabled &&
    threshold !== null && Number.isSafeInteger(threshold) && threshold > 0;
  const remaining = enabled && subtotal !== null ? Math.max(0, threshold - subtotal) : null;
  const eligible = remaining === 0;
  const price = eligible ? 0 : null; // The existing carrier quote is only available after assembly.
  return {
    enabled, threshold: enabled ? threshold : null, remaining, eligible,
    progress: enabled && subtotal !== null ? Math.min(100, Math.max(0, Math.floor(subtotal * 100 / threshold))) : 0,
    price, total: totalWithDelivery(subtotal, price),
  };
}
