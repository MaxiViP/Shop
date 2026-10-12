import type { Unit } from "~/types/product";
import type { Sale } from './sale.ts';
import { variableWeight } from './sale.ts';

function plural(value: number, labels: readonly [string, string, string]) {
  const last = value % 10;
  return labels[value % 100 >= 11 && value % 100 <= 14 ? 2 : last === 1 ? 0 : last >= 2 && last <= 4 ? 1 : 2];
}

export function qtyText(unit: Unit, value: number, product?: Sale) {
  if (product && variableWeight(product) && unit === 'PIECE') {
    const labels: Record<string, readonly [string, string, string]> = {
      'кусок': ['кусок', 'куска', 'кусков'], 'тушка': ['тушка', 'тушки', 'тушек'],
      'рыба': ['рыба', 'рыбы', 'рыб'], 'кочан': ['кочан', 'кочана', 'кочанов'],
    };
    return `${value} ${plural(value, labels[product.wholeLabel ?? ''] ?? ['шт.', 'шт.', 'шт.'])}`;
  }
  if (unit === "GRAM") {
    if (value >= 1000) {
      return `${(value / 1000).toLocaleString("ru-RU", {
        maximumFractionDigits: 3,
      })} кг`;
    }

    return `${value} г`;
  }

  const labels: Record<Exclude<Unit, "GRAM">, string> = {
    PIECE: "шт.",
    BUNCH: plural(value, ['пучок', 'пучка', 'пучков']),
    PACK: plural(value, ['упаковка', 'упаковки', 'упаковок']),
  };

  return `${value} ${labels[unit]}`;
}
