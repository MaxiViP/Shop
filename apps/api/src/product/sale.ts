// Dependency-free: also consumed by Nuxt and native Node storefront tests.
const MAX_QTY = 1_000_000;

export const saleModels = [
  'WEIGHT_LOOSE',
  'PIECE_FIXED',
  'BUNCH',
  'PACK',
  'WHOLE_VARIABLE_WEIGHT',
  'CUT_TO_WEIGHT',
] as const;
export type SaleModel = (typeof saleModels)[number];
export type SaleUnit = 'GRAM' | 'PIECE' | 'BUNCH' | 'PACK';
export const wholeLabels = ['шт.', 'кусок', 'тушка', 'рыба', 'кочан'] as const;
export interface Sale {
  unit: SaleUnit;
  saleModel?: SaleModel | null;
  priceUnit?: SaleUnit | null;
  wholeLabel?: string | null;
  estimatedWeightGrams?: number | null;
}
export function saleModel(product: Sale): SaleModel {
  return (
    product.saleModel ??
    (
      {
        GRAM: 'WEIGHT_LOOSE',
        PIECE: 'PIECE_FIXED',
        BUNCH: 'BUNCH',
        PACK: 'PACK',
      } as const
    )[product.unit]
  );
}
export function priceUnit(product: Sale): SaleUnit {
  return product.priceUnit ?? product.unit;
}
export function variableWeight(product: Sale): boolean {
  return priceUnit(product) === 'GRAM' && product.unit !== 'GRAM';
}
export function compatibleQuantityUnit(
  previous: SaleUnit | null | undefined,
  product: Sale,
): boolean {
  if (variableWeight(product)) return previous === product.unit;
  if (previous == null || previous === product.unit) return true;
  // The audit's fixed SKU -> pack correction preserves the existing count.
  return (
    (previous === 'PIECE' && product.unit === 'PACK') ||
    (previous === 'PACK' && product.unit === 'PIECE')
  );
}
export function saleErrors(
  product: Sale & {
    priceQty: number;
    min: number;
    step: number;
    portionQty: number;
  },
) {
  const errors: Record<string, string> = {};
  const model = saleModel(product);
  const base = priceUnit(product);
  if (model === 'WHOLE_VARIABLE_WEIGHT') {
    if (
      product.unit !== 'PIECE' ||
      base !== 'GRAM' ||
      product.priceQty !== 1000
    )
      errors.saleModel =
        'Целый весовой товар: экземпляры в штуках, цена за 1000 г.';
  } else if (model === 'BUNCH') {
    if (product.unit !== 'BUNCH' || !['GRAM', 'BUNCH'].includes(base))
      errors.saleModel =
        'Пучки: количество в пучках, цена за пучок или за вес.';
    if (base === 'GRAM' && product.priceQty !== 1000)
      errors.priceQty = 'Весовые пучки: цена за 1000 г.';
  } else {
    const expected =
      model === 'PACK' ? 'PACK' : model === 'PIECE_FIXED' ? 'PIECE' : 'GRAM';
    if (product.unit !== expected || base !== expected)
      errors.saleModel =
        'Единицы количества и цены не соответствуют способу продажи.';
  }
  // Legacy multi-unit price bases remain valid until explicitly audited.
  if (product.saleModel && base !== 'GRAM' && product.priceQty !== 1)
    errors.priceQty = 'Для этой модели укажите цену за одну единицу.';
  if (
    product.saleModel &&
    product.unit !== 'GRAM' &&
    [product.min, product.step, product.portionQty].some((value) => value !== 1)
  )
    errors.step = 'Экземпляры, пучки и упаковки добавляются по одной единице.';
  if (
    product.wholeLabel &&
    (!variableWeight(product) ||
      !wholeLabels.includes(product.wholeLabel as (typeof wholeLabels)[number]))
  )
    errors.wholeLabel = 'Выберите название целого экземпляра.';
  if (
    product.estimatedWeightGrams != null &&
    (!variableWeight(product) ||
      !Number.isSafeInteger(product.estimatedWeightGrams) ||
      product.estimatedWeightGrams < 1 ||
      product.estimatedWeightGrams > MAX_QTY)
  )
    errors.estimatedWeightGrams =
      'Оценочный вес допустим только для целого весового товара; нужна подтверждённая оценка продавца.';
  return errors;
}
export function estimatedQuantity(product: Sale, qty: number): number | null {
  if (!variableWeight(product)) return qty;
  if (!product.estimatedWeightGrams) return null;
  const weight = product.estimatedWeightGrams * qty;
  if (!Number.isSafeInteger(weight) || weight > MAX_QTY)
    throw new RangeError('Оценочный вес превышает допустимое количество');
  return weight;
}

export interface WeighedItem extends Sale {
  qty: number;
  actualQty: number | null;
  actualWeightGrams?: number | null;
  pieceWeights?: unknown;
  weightMinGrams?: number | null;
  weightMaxGrams?: number | null;
}
export function actualQuantity(item: WeighedItem): number {
  const qty = item.actualQty;
  if (!Number.isSafeInteger(qty) || qty === null || qty < 1 || qty > MAX_QTY)
    throw new RangeError('Укажите фактическое количество');
  if (!variableWeight(item)) {
    if (item.actualWeightGrams != null || item.pieceWeights != null)
      throw new RangeError('Этот товар собирается в своей единице количества');
    return qty;
  }
  const weights = item.pieceWeights;
  if (
    !Array.isArray(weights) ||
    weights.length !== qty ||
    qty > 100 ||
    weights.some(
      (weight: unknown) =>
        typeof weight !== 'number' ||
        !Number.isSafeInteger(weight) ||
        weight < 1 ||
        weight > MAX_QTY,
    )
  )
    throw new RangeError(
      'Укажите положительный вес каждого экземпляра (до 100 экземпляров)',
    );
  const weight = (weights as number[]).reduce((sum, value) => sum + value, 0);
  if (weight > MAX_QTY || weight !== item.actualWeightGrams)
    throw new RangeError(
      'Общий фактический вес не совпадает с весами экземпляров',
    );
  return weight;
}
export function needsWeightApproval(item: WeighedItem, bps: number): boolean {
  const actual = actualQuantity(item);
  if (variableWeight(item)) {
    const weights = item.pieceWeights as number[];
    return (
      item.actualQty !== item.qty ||
      weights.some(
        (weight) =>
          (item.weightMinGrams != null && weight < item.weightMinGrams) ||
          (item.weightMaxGrams != null && weight > item.weightMaxGrams),
      )
    );
  }
  if (item.unit !== 'GRAM') return item.actualQty !== item.qty;
  // Percent tolerance applies only to a buyer's requested grams.
  return (
    BigInt(actual) * 10000n < BigInt(item.qty) * BigInt(10000 - bps) ||
    BigInt(actual) * 10000n > BigInt(item.qty) * BigInt(10000 + bps)
  );
}

export function approvedItemWeight(
  issue:
    | {
        status: string;
        resolution: string | null;
        actualQty: number | null;
        approvedActualQty: number | null;
        approvedWeightGrams?: number | null;
        approvedPieceWeights?: unknown;
      }
    | undefined,
  item: WeighedItem,
): boolean {
  return (
    item.actualQty !== null &&
    issue?.status === 'RESOLVED' &&
    issue.resolution === 'ACCEPT_ACTUAL' &&
    issue.actualQty === item.actualQty &&
    issue.approvedActualQty === item.actualQty &&
    (!variableWeight(item) ||
      (issue.approvedWeightGrams === item.actualWeightGrams &&
        JSON.stringify(issue.approvedPieceWeights) ===
          JSON.stringify(item.pieceWeights)))
  );
}
