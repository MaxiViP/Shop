import type { OrderStatus, OrderType } from "../types/order";

export function orderProgress(status: OrderStatus, type: OrderType) {
  const flow: { status: OrderStatus; label: string }[] = [
    { status: "NEW", label: "Принят" },
    { status: "CONFIRMED", label: "Подтверждён" },
    { status: "ASSEMBLING", label: "Собираем" },
    { status: "READY", label: type === "PICKUP" ? "Готов к выдаче" : "Готов" },
    ...(type === "DELIVERY"
      ? [{ status: "DELIVERING" as const, label: "В пути" }]
      : []),
    { status: "COMPLETED", label: "Завершён" },
  ];
  const current = flow.findIndex((step) => step.status === status);
  const canceled = status === "CANCELED";
  return {
    canceled,
    unknown: !canceled && current === -1,
    steps:
      canceled || current === -1
        ? []
        : flow.map((step, index) => ({
            ...step,
            state:
              status === "COMPLETED" || index < current
                ? ("completed" as const)
                : index === current
                  ? ("current" as const)
                  : ("future" as const),
          })),
  };
}
