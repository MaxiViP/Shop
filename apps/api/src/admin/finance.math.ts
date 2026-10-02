import { lineAmount } from '../order/assembly.js';
import type { SettlementMode } from '../db/gen/client.js';

export type FinanceItem = {
  id: number; productName: string; status: 'PENDING' | 'PICKED' | 'MISSING';
  qty: number; actualQty: number | null; total: number; actualTotal: number | null;
  price: number; actualPrice: number | null; priceQty: number;
  settlementModeSnapshot: SettlementMode | null; basePriceSnapshot: number | null;
};
function safe(value: bigint) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER))
    throw new RangeError('Financial total exceeds the safe integer range');
  return Number(value);
}
export function splitMarkup(markup: bigint) {
  const partner1Share = markup / 2n;
  return { partner1Share: safe(partner1Share), partner2Share: safe(markup - partner1Share) };
}
export function financeLine(item: FinanceItem) {
  const qty = item.status === 'MISSING' ? 0 : item.actualQty ?? item.qty;
  const saleAmount = qty > 0 ? item.actualTotal ?? item.total : 0;
  const mode = item.settlementModeSnapshot;
  const category = mode === null || (mode === 'SHARED_MARKUP' && item.basePriceSnapshot === null)
    ? 'LEGACY' : mode;
  const baseAmount = category === 'SHARED_MARKUP' && qty > 0
    ? lineAmount(item.basePriceSnapshot!, qty, item.priceQty) : 0;
  const sharedMarkup = category === 'SHARED_MARKUP' ? saleAmount - baseAmount : 0;
  return {
    id: item.id, productName: item.productName, mode: category, qty,
    orderPrice: item.price, finalPrice: item.actualPrice ?? item.price, priceQty: item.priceQty,
    saleAmount, baseAmount, sharedMarkup,
  };
}
export type CalculatedLine = ReturnType<typeof financeLine>;
export function financeTotals(lines: CalculatedLine[], extrasAmount = 0, deliveryAmount = 0) {
  const sum = (mode: CalculatedLine['mode'] | null) => lines.reduce((acc, item) =>
    acc + (mode === null || item.mode === mode ? BigInt(item.saleAmount) : 0n), 0n);
  const goodsRevenue = sum(null);
  const sharedRevenue = sum('SHARED_MARKUP');
  const noMarkupRevenue = sum('NO_MARKUP');
  const unsetRevenue = sum('UNSET');
  const legacyRevenue = sum('LEGACY');
  const baseAmount = lines.reduce((acc, item) => acc + BigInt(item.baseAmount), 0n);
  const markup = lines.reduce((acc, item) => acc + BigInt(item.sharedMarkup), 0n);
  const delivery = BigInt(deliveryAmount);
  const extras = BigInt(extrasAmount);
  return {
    turnover: safe(goodsRevenue + delivery + extras), goodsRevenue: safe(goodsRevenue),
    sharedRevenue: safe(sharedRevenue), noMarkupRevenue: safe(noMarkupRevenue),
    unsetRevenue: safe(unsetRevenue), legacyRevenue: safe(legacyRevenue),
    legacyItemsCount: lines.filter(item => item.mode === 'LEGACY').length,
    baseAmount: safe(baseAmount), sharedMarkup: safe(markup),
    ...splitMarkup(markup), delivery: safe(delivery), extras: safe(extras),
  };
}
