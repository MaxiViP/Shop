import type { Unit } from "~/types/product";

export function qtyText(unit: Unit, value: number) {
  if (unit === "GRAM") {
    if (value >= 1000) {
      return `${(value / 1000).toLocaleString("ru-RU", {
        maximumFractionDigits: 2,
      })} кг`;
    }

    return `${value} г`;
  }

  const labels: Record<Exclude<Unit, "GRAM">, string> = {
    PIECE: "шт.",
    BUNCH: "пуч.",
    PACK: "уп.",
  };

  return `${value} ${labels[unit]}`;
}
