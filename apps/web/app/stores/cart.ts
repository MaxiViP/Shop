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
  type ServerCartSnapshot,
  type ServerCartChange,
} from "../utils/cart.ts";

export const useCartStore = defineStore("cart", () => {
  const items = ref<CartItem[]>([]);
  const mode = ref<"guest" | "server">("guest");
  const serverOwner = ref<number | null>(null);
  const serverRevision = ref<string | null>(null);
  const serverBusy = ref(false);
  let serverApi: {
    get: () => Promise<ServerCartSnapshot>;
    change: (body: ServerCartChange & { revision: string }) => Promise<ServerCartSnapshot>;
  } | null = null;
  let queue: Promise<void> = Promise.resolve();
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

  function bindServer(api: NonNullable<typeof serverApi>) {
    serverApi = api;
  }

  function beginServer(userId: number) {
    mode.value = "server";
    serverOwner.value = userId;
    serverRevision.value = null;
    restored.value = false;
    items.value = [];
    quote.value = null;
    quotedKey.value = null;
    priceChanged.value = false;
  }

  function beginGuest() {
    mode.value = "guest";
    serverOwner.value = null;
    serverRevision.value = null;
    restored.value = false;
    items.value = [];
    quote.value = null;
    quotedKey.value = null;
    priceChanged.value = false;
  }

  function applyServer(snapshot: ServerCartSnapshot, userId: number) {
    if (mode.value !== "server" || serverOwner.value !== userId) return false;
    const next = snapshot.items.map((line) => {
      const product = line.product ?? snapshot.products.find((p) => p.id === line.productId);
      if (!product) throw new Error("Cart product metadata is missing");
      return { product, qty: line.qty };
    });
    for (const item of next) {
      const previous = items.value.find((row) => row.product.id === item.product.id);
      if (previous && (previous.product.price !== item.product.price ||
        previous.product.priceQty !== item.product.priceQty))
        priceChanged.value = true;
    }
    items.value = next;
    quote.value = snapshot;
    quotedKey.value = cartKey(next);
    serverRevision.value = snapshot.revision;
    restored.value = true;
    storageWarning.value = "";
    return true;
  }

  function enqueue<T>(work: () => Promise<T>) {
    const task = queue.then(work);
    queue = task.then(() => undefined, () => undefined);
    return task;
  }

  function refreshServer() {
    const userId = serverOwner.value;
    if (mode.value !== "server" || userId === null || !serverApi)
      return Promise.resolve(false);
    const api = serverApi;
    return enqueue(async () => {
      try {
        const snapshot = await api.get();
        return applyServer(snapshot, userId);
      } catch {
        return false;
      }
    });
  }

  function changeServer(change: ServerCartChange) {
    const userId = serverOwner.value;
    if (mode.value !== "server" || userId === null || !serverApi)
      return Promise.resolve(false);
    const api = serverApi;
    return enqueue(async () => {
      if (mode.value !== "server" || serverOwner.value !== userId ||
          !restored.value || !serverRevision.value) return false;
      serverBusy.value = true;
      try {
        const snapshot = await api.change({ ...change, revision: serverRevision.value });
        return applyServer(snapshot, userId);
      } catch (cause) {
        if (typeof cause === "object" && cause !== null &&
          "statusCode" in cause && cause.statusCode === 409) {
          try { applyServer(await api.get(), userId); } catch { /* Keep last known cart. */ }
        }
        return false;
      } finally {
        serverBusy.value = false;
      }
    });
  }

  return {
    items,
    mode,
    serverOwner,
    serverRevision,
    serverBusy,
    bindServer,
    beginServer,
    beginGuest,
    applyServer,
    refreshServer,
    changeServer,
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
