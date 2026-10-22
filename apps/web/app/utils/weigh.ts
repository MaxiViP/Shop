import { variableWeight, type Sale } from './sale';

export interface WeighQuote {
  actualQty: number;
  actualWeightGrams: number | null;
  actualTotal: number;
  quantityDelta: number;
  amountDelta: number | null;
  requiresApproval: boolean;
}
export function weighInput(item: Sale, quantity: string, weights: readonly string[]) {
  const integer = (value: string) => /^[1-9]\d{0,6}$/.test(value.trim()) && Number(value.trim()) <= 1_000_000;
  if (!integer(quantity)) return null;
  const actualQty = Number(quantity.trim());
  if (!variableWeight(item)) return { status: 'PICKED' as const, actualQty };
  if (actualQty > 100 || weights.length !== actualQty || weights.some(value => !integer(value))) return null;
  const pieceWeights = weights.map(value => Number(value.trim()));
  if (pieceWeights.reduce((sum, value) => sum + value, 0) > 1_000_000) return null;
  return { status: 'PICKED' as const, actualQty, pieceWeights };
}
export function nextWeighItem(items: readonly { id: number; status: string }[],
  issues: readonly { orderItemId: number; status: string }[], after: number) {
  const waiting = new Set(issues.filter(issue => issue.status === 'WAITING_CUSTOMER').map(issue => issue.orderItemId));
  const offset = items.findIndex(item => item.id === after) + 1;
  return [...items.slice(offset), ...items.slice(0, offset)]
    .find(item => item.id !== after && item.status === 'PENDING' && !waiting.has(item.id))?.id ?? null;
}
