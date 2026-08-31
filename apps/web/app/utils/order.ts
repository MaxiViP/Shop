import type { OrderStatus } from "~/types/order";

export const orderStatus = {
  NEW: {
    label: "Заказ принят",
    color: "info",
  },

  CONFIRMED: {
    label: "Подтверждён",
    color: "primary",
  },

  ASSEMBLING: {
    label: "Собираем заказ",
    color: "warning",
  },

  READY: {
    label: "Заказ собран",
    color: "primary",
  },

  DELIVERING: {
    label: "Курьер в пути",
    color: "warning",
  },

  COMPLETED: {
    label: "Доставлен",
    color: "success",
  },

  CANCELED: {
    label: "Отменён",
    color: "error",
  },
} as const satisfies Record<
  OrderStatus,
  {
    label: string;
    color: "primary" | "success" | "warning" | "error" | "info";
  }
>;

export function isActiveOrder(status: OrderStatus) {
  return !["COMPLETED", "CANCELED"].includes(status);
}
