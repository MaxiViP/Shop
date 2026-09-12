import type { ProductListItem, Unit } from "../types/product";

export interface CartItem {
  product: ProductListItem;
  qty: number;
}
export interface CartQuoteLine {
  productId: number;
  qty: number;
  product: ProductListItem | null;
  status: "AVAILABLE" | "UNAVAILABLE" | "INVALID_QUANTITY" | "PRICE_OVERFLOW";
  lineTotal: number | null;
}
export interface CartQuote {
  items: CartQuoteLine[];
  subtotal: number | null;
  valid: boolean;
  error: "TOTAL_OVERFLOW" | null;
  token: string | null;
}
export function checkoutRedirect(restored: boolean, count: number) {
  return restored && count === 0;
}
export function validCartQty(
  qty: number,
  product: Pick<ProductListItem, "min" | "step">,
) {
  return (
    Number.isSafeInteger(qty) &&
    qty >= product.min &&
    qty <= 1_000_000 &&
    product.min > 0 &&
    product.step > 0 &&
    (qty - product.min) % product.step === 0
  );
}
export function nextCartQty(
  current: number | undefined,
  product: Pick<ProductListItem, "min" | "step">,
) {
  if (current === undefined)
    return validCartQty(product.min, product) ? product.min : null;
  if (!validCartQty(current, product)) return null; // Explicit correction in cart, never silent rounding.
  const next = current + product.step;
  return validCartQty(next, product) ? next : null;
}
export function cartKey(items: CartItem[]) {
  return JSON.stringify(items.map((item) => [item.product.id, item.qty]));
}
export function reconcileCart(
  items: CartItem[],
  quote: CartQuote,
  requestedKey: string,
) {
  if (cartKey(items) !== requestedKey) return null;
  if (
    items.length !== quote.items.length ||
    items.some(
      (item) =>
        !quote.items.some(
          (line) => line.productId === item.product.id && line.qty === item.qty,
        ),
    )
  )
    return null;
  let priceChanged = false;
  const updated = items.map((item) => {
    const product = quote.items.find(
      (line) => line.productId === item.product.id,
    )!.product;
    if (!product) return item; // Keep unavailable lines visible, with their saved name.
    if (
      product.price !== item.product.price ||
      product.priceQty !== item.product.priceQty ||
      product.unit !== item.product.unit
    )
      priceChanged = true;
    return { product, qty: item.qty };
  });
  return { items: updated, priceChanged };
}
export function cartLineMessage(line: CartQuoteLine | undefined) {
  if (line?.status === "UNAVAILABLE")
    return "Товар больше недоступен. Удалите его из корзины.";
  if (line?.status === "INVALID_QUANTITY")
    return "Количество не соответствует текущему минимуму или шагу продажи.";
  if (line?.status === "PRICE_OVERFLOW")
    return "Стоимость позиции слишком велика. Уменьшите количество.";
  return "";
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const positiveInt = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value > 0 &&
  value <= 2_147_483_647;
function storedItem(value: unknown): CartItem | null {
  if (
    !record(value) ||
    !record(value.product) ||
    typeof value.qty !== "number" ||
    !Number.isFinite(value.qty) ||
    Math.abs(value.qty) > Number.MAX_SAFE_INTEGER
  )
    return null;
  const p = value.product;
  if (
    !positiveInt(p.id) ||
    typeof p.name !== "string" ||
    typeof p.slug !== "string" ||
    !positiveInt(p.price) ||
    !positiveInt(p.priceQty) ||
    !positiveInt(p.min) ||
    !positiveInt(p.step) ||
    !["GRAM", "PIECE", "PACK", "BUNCH"].includes(String(p.unit)) ||
    !record(p.category) ||
    typeof p.category.name !== "string" ||
    typeof p.category.slug !== "string" ||
    !Array.isArray(p.images)
  )
    return null;
  return {
    qty: value.qty,
    product: {
      id: p.id,
      name: p.name,
      slug: p.slug,
      price: p.price,
      priceQty: p.priceQty,
      min: p.min,
      step: p.step,
      unit: p.unit as Unit,
      category: { name: p.category.name, slug: p.category.slug },
      images: p.images
        .filter(record)
        .filter((image) => typeof image.url === "string")
        .map((image) => ({
          url: image.url as string,
          alt: typeof image.alt === "string" ? image.alt : null,
        })),
    },
  };
}
export function decodeCart(raw: string | null): {
  items: CartItem[];
  warning: string;
} {
  if (!raw) return { items: [], warning: "" };
  const warning =
    "Часть сохранённой корзины повреждена. Проверьте список товаров.";
  try {
    const data: unknown = JSON.parse(raw);
    const rows = Array.isArray(data)
      ? data
      : record(data) && data.version === 1
        ? data.items
        : null;
    if (!Array.isArray(rows)) return { items: [], warning };
    const items: CartItem[] = [];
    for (const row of rows.slice(0, 50)) {
      const item = storedItem(row);
      if (
        item &&
        !items.some((current) => current.product.id === item.product.id)
      )
        items.push(item);
    }
    return { items, warning: items.length === rows.length ? "" : warning };
  } catch {
    return { items: [], warning };
  }
}
