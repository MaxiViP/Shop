import type { ProductPriceStatus } from '~/types/product';

export const priceStatusLabels: Record<ProductPriceStatus, string> = {
  ESTIMATED: 'Ориентировочная',
  SOURCE: 'Из открытого источника',
  AUDITED: 'Проверена на рынке',
};
export const priceStatusItems = Object.entries(priceStatusLabels).map(([value, label]) => ({
  value: value as ProductPriceStatus, label,
}));
