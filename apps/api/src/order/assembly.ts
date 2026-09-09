// Pure rules shared with the storefront preview. No server imports or configuration.
export const MAX_QTY = 1_000_000;
export const MAX_MONEY = 2_147_483_647;

export function approvedWeight(issue: { status: string; resolution: string | null; approvedActualQty: number | null; actualQty: number | null } | undefined, actual: number | null) {
  return actual !== null && issue?.status === 'RESOLVED' && issue.resolution === 'ACCEPT_ACTUAL' && issue.approvedActualQty === actual && issue.actualQty === actual;
}

function integer(value: number, min: number, max: number) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new RangeError('Количество или сумма вне допустимого диапазона');
  return BigInt(value);
}

export function lineAmount(
  price: number,
  qty: number,
  priceQty: number,
): number {
  const numerator = integer(price, 1, MAX_MONEY) * integer(qty, 1, MAX_QTY);
  const denominator = integer(priceQty, 1, MAX_QTY);
  // Positive half-up rounding, without floating-point intermediate products.
  const result = (2n * numerator + denominator) / (2n * denominator);
  if (result > BigInt(MAX_MONEY))
    throw new RangeError('Сумма позиции превышает допустимую стоимость');
  return Number(result);
}

export function sumAmounts(values: number[]): number {
  const sum = values.reduce(
    (total, value) => total + integer(value, 0, MAX_MONEY),
    0n,
  );
  if (sum > BigInt(MAX_MONEY))
    throw new RangeError('Сумма заказа превышает допустимую стоимость');
  return Number(sum);
}

export function weightRange(requested: number, bps: number) {
  const qty = integer(requested, 1, MAX_QTY);
  const tolerance = integer(bps, 0, 5000);
  return {
    min: Number((qty * (10000n - tolerance) + 9999n) / 10000n),
    max: Math.min(MAX_QTY, Number((qty * (10000n + tolerance)) / 10000n)),
  };
}

export function outsideTolerance(
  unit: string,
  requested: number,
  actual: number,
  bps: number,
) {
  integer(actual, 1, MAX_QTY);
  if (unit !== 'GRAM') return false;
  const range = weightRange(requested, bps);
  return actual < range.min || actual > range.max;
}
