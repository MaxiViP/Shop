import type { OrderStatus } from "../types/order";

export const staffTabs: {
  value: string;
  label: string;
  statuses: OrderStatus[];
}[] = [
  { value: "new", label: "Новые", statuses: ["NEW"] },
  {
    value: "assembly",
    label: "К сборке",
    statuses: ["CONFIRMED", "ASSEMBLING"],
  },
  { value: "ready", label: "Готовы", statuses: ["READY"] },
  { value: "delivering", label: "В пути", statuses: ["DELIVERING"] },
  { value: "finished", label: "Завершённые", statuses: ["COMPLETED"] },
  { value: "canceled", label: "Отменённые", statuses: ["CANCELED"] },
];
export function staffTab(value: unknown) {
  if (value === "confirmed" || value === "assembling") return "assembly";
  return staffTabs.some((tab) => tab.value === value) ? String(value) : "new";
}
export function tabForStatus(status: OrderStatus) {
  return staffTabs.find((tab) => tab.statuses.includes(status))?.value ?? "new";
}
