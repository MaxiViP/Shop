import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import type { Prisma } from '../db/gen/client.js';
import { productListSelect } from '../product/select.js';
import { MAX_QTY } from './assembly.js';
import { goodsLine, goodsSum } from './pricing.js';

// Strip unsolicited client prices. Only IDs and quantities are used.
export const quoteSchema = z.object({
  items: z
    .array(
      z.object({
        productId: z.number().int().positive().max(2_147_483_647),
        // Legacy min/step violations are returned per line, not as an opaque 400.
        qty: z
          .number()
          .min(-Number.MAX_SAFE_INTEGER)
          .max(Number.MAX_SAFE_INTEGER),
      }),
    )
    .min(1)
    .max(50),
});
export type QuoteInput = z.infer<typeof quoteSchema>;
export const cartProductSelect = {
  ...productListSelect,
  images: { ...productListSelect.images, take: 1 },
} satisfies Prisma.ProductSelect;
type CartProduct = Prisma.ProductGetPayload<{
  select: typeof cartProductSelect;
}>;
type LineStatus =
  'AVAILABLE' | 'UNAVAILABLE' | 'INVALID_QUANTITY' | 'PRICE_OVERFLOW';

export function cartQuantityValid(qty: number, min: number, step: number) {
  return (
    Number.isSafeInteger(qty) &&
    qty >= min &&
    qty <= MAX_QTY &&
    Number.isSafeInteger(min) &&
    min > 0 &&
    Number.isSafeInteger(step) &&
    step > 0 &&
    (qty - min) % step === 0
  );
}

export function cartQuantities(items: QuoteInput['items']) {
  const quantities = new Map<number, number>();
  for (const item of items)
    quantities.set(
      item.productId,
      (quantities.get(item.productId) ?? 0) + item.qty,
    );
  return quantities;
}

export function cartQuote(
  quantities: Map<number, number>,
  products: CartProduct[],
) {
  const byId = new Map(products.map((product) => [product.id, product]));
  const items = [...quantities].map(([productId, qty]) => {
    const product = byId.get(productId) ?? null;
    let status: LineStatus = 'UNAVAILABLE';
    let lineTotal: number | null = null;
    if (product) {
      status = cartQuantityValid(qty, product.min, product.step)
        ? 'AVAILABLE'
        : 'INVALID_QUANTITY';
      if (status === 'AVAILABLE') {
        try {
          lineTotal = goodsLine(product.price, qty, product.priceQty);
        } catch (error) {
          if (!(error instanceof BadRequestException)) throw error;
          status = 'PRICE_OVERFLOW';
        }
      }
    }
    return { productId, qty, product, status, lineTotal };
  });
  let subtotal: number | null = null;
  let error: 'TOTAL_OVERFLOW' | null = null;
  if (items.every((item) => item.status === 'AVAILABLE')) {
    try {
      subtotal = goodsSum(items.map((item) => item.lineTotal!));
    } catch (cause) {
      if (!(cause instanceof BadRequestException)) throw cause;
      error = 'TOTAL_OVERFLOW';
    }
  }
  // A comparison fingerprint, NOT a trusted price, reservation or idempotency key.
  // Create recalculates it from freshly read products before any write.
  const token =
    subtotal === null
      ? null
      : createHash('sha256')
          .update(
            JSON.stringify(
              [...items]
                .sort((a, b) => a.productId - b.productId)
                .map((item) => {
                  const p = item.product!;
                  return [
                    item.productId,
                    item.qty,
                    p.price,
                    p.priceQty,
                    p.unit,
                    p.min,
                    p.step,
                  ];
                }),
            ),
          )
          .digest('hex');
  return { items, subtotal, valid: subtotal !== null, error, token };
}
