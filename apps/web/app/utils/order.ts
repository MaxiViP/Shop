import type { OrderStatus, OrderType } from "~/types/order";

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

export function orderMeta(status: OrderStatus, type: OrderType = 'DELIVERY') {
  const meta = orderStatus[status];
  if (type === 'PICKUP' && status === 'READY') return { ...meta, label: 'Заказ готов к выдаче' };
  if (type === 'PICKUP' && status === 'COMPLETED') return { ...meta, label: 'Выдан покупателю' };
  return meta;
}
