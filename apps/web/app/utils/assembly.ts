// Import only the dependency-free calculation module, never backend services/env.
export {
  lineAmount,
  outsideTolerance,
  weightRange,
  approvedWeight,
} from "../../../api/src/order/assembly.ts";

export function percentToBps(value: string): number | null {
  const match = /^(\d{1,2})(?:[.,](\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const bps = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return bps <= 5000 ? bps : null;
}
export function bpsPercent(bps: number): string {
  return (bps / 100).toLocaleString("ru-RU", { maximumFractionDigits: 2 });
}
