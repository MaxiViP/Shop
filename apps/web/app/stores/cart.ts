import { computed, ref } from "vue";
import { defineStore } from "pinia";
import type { ProductListItem } from "~/types/product";
import {
  cartKey,
  nextCartQty,
  previousCartQty,
  validCartQty,
  reconcileCart,
  type CartItem,
  type CartQuote,
} from "../utils/cart.ts";

export const useCartStore = defineStore("cart", () => {
  const items = ref<CartItem[]>([]);
  const restored = ref(false);
  const storageWarning = ref("");
  const priceChanged = ref(false);
  const quote = ref<CartQuote | null>(null);
  const quotedKey = ref<string | null>(null);
  const key = computed(() => cartKey(items.value));
  const quoteReady = computed(
    () =>
      restored.value && quote.value !== null && quotedKey.value === key.value,
  );

  const count = computed(() => items.value.length);

  function qty(id: number) {
    return items.value.find((item) => item.product.id === id)?.qty ?? 0;
  }

  const total = computed(() =>
    quoteReady.value ? quote.value!.subtotal : null,
  );

  // Display only: these server amounts may belong to an earlier cart quantity.
  // Eligibility and order submission must use total/quoteReady instead.
  const displayTotal = computed(() =>
    restored.value && count.value ? quote.value?.subtotal ?? null : null,
  );
  function displayLineTotal(id: number) {
    return restored.value && qty(id) > 0
      ? quote.value?.items.find((line) => line.productId === id)?.lineTotal ?? null
      : null;
  }

  function quoteLine(id: number) {
    return quoteReady.value
      ? quote.value?.items.find((item) => item.productId === id)
      : undefined;
  }

  function lineTotal(item: CartItem) {
    return quoteLine(item.product.id)?.lineTotal ?? null;
  }

  function add(product: ProductListItem) {
    const item = items.value.find((item) => item.product.id === product.id);
    const next = nextCartQty(item?.qty, product);
    return next !== null && put(product, next);
  }

  function subtract(product: ProductListItem) {
    const item = items.value.find((item) => item.product.id === product.id);
    if (!item) return false;
    const next = previousCartQty(item.qty, product);
    if (next === null) return false;
    if (next === 0) {
      remove(product.id);
      return true;
    }
    return put(product, next);
  }

  // Product detail edits the desired TOTAL, never adds two min-based quantities.
  function put(product: ProductListItem, qty: number) {
    if (!validCartQty(qty, product)) return false;
    const item = items.value.find((item) => item.product.id === product.id);
    if (!item && items.value.length >= 50) return false;
    // The same desired quantity is a no-op. Keep reconciled server product data,
    // rather than replacing it with a potentially older catalog snapshot.
    if (item?.qty === qty) return true;
    invalidateQuote();
    if (item) {
      item.product = product;
      item.qty = qty;
    } else items.value.push({ product, qty });
    return true;
  }

  function setQty(id: number, qty: number) {
    const item = items.value.find((item) => item.product.id === id);

    if (!item) return false;
    return put(item.product, qty);
  }

  function remove(id: number) {
    invalidateQuote();
    items.value = items.value.filter((item) => item.product.id !== id);
  }

  function clear() {
    invalidateQuote();
    items.value = [];
    quote.value = null;
    priceChanged.value = false;
  }

  function restore(value: CartItem[], warning = "") {
    invalidateQuote();
    quote.value = null;
    items.value = value;
    storageWarning.value = warning;
    restored.value = true;
  }

  function invalidateQuote() {
    quotedKey.value = null;
  }
  function applyQuote(value: CartQuote, requestedKey: string) {
    const result = reconcileCart(items.value, value, requestedKey);
    if (!result) return false;
    items.value = result.items;
    priceChanged.value ||= result.priceChanged;
    quote.value = value;
    quotedKey.value = requestedKey;
    return true;
  }

  return {
    items,
    count,
    qty,
    total,
    lineTotal,
    displayTotal,
    displayLineTotal,
    add,
    subtract,
    setQty,
    remove,
    clear,
    restore,
    put,
    restored,
    storageWarning,
    priceChanged,
    key,
    quote,
    quoteReady,
    quotedKey,
    quoteLine,
    invalidateQuote,
    applyQuote,
  };
});
