import { computed, inject, onBeforeUnmount, onMounted, provide, ref, watch } from "vue";
import type { ComputedRef, InjectionKey, Ref } from "vue";
import { useCartStore } from "../stores/cart.ts";
import type { CartQuote } from "../utils/cart.ts";

type QuoteState = {
  pending: Ref<boolean>;
  error: Ref<string>;
  refresh: () => Promise<boolean>;
  ready: ComputedRef<boolean>;
};
const quoteKey: InjectionKey<QuoteState> = Symbol("cart-quote");

export function useCartQuote(): QuoteState {
  // The storefront layout owns one request lifecycle shared by its descendants.
  const shared = inject(quoteKey, null);
  if (shared) return shared;
  const cart = useCartStore();
  const api = useApiClient();
  const pending = ref(false);
  const error = ref("");
  const mounted = ref(false);
  let disposed = false;
  let sequence = 0;
  let controller: AbortController | undefined;

  async function refresh() {
    controller?.abort();
    const request = ++sequence;
    if (disposed || !cart.restored) {
      error.value = "";
      pending.value = false;
      return false;
    }
    if (cart.mode === "server") {
      pending.value = true;
      error.value = "";
      try {
        const applied = await cart.refreshServer();
        if (!applied) error.value = "Не удалось обновить общую корзину. Повторите попытку.";
        return applied;
      } finally {
        pending.value = false;
      }
    }
    if (!cart.count) {
      error.value = "";
      pending.value = false;
      return false;
    }
    const requestedKey = cart.key;
    const abort = new AbortController();
    controller = abort;
    cart.invalidateQuote();
    pending.value = true;
    error.value = "";
    try {
      const quote = await api<CartQuote>("/orders/quote", {
        method: "POST",
        signal: abort.signal,
        body: {
          items: cart.items.map((item) => ({
            productId: item.product.id,
            qty: item.qty,
          })),
        },
      });
      if (disposed || request !== sequence) return false;
      const applied = cart.applyQuote(quote, requestedKey);
      if (!applied) error.value = "Корзина изменилась. Повторите проверку.";
      return applied;
    } catch {
      if (!disposed && request === sequence)
        error.value =
          "Не удалось проверить актуальные цены. Корзина сохранена — повторите попытку.";
      return false;
    } finally {
      if (!disposed && request === sequence) pending.value = false;
    }
  }
  onMounted(() => {
    mounted.value = true;
    void refresh();
  });
  watch(
    () => cart.mode === "guest"
      ? [cart.mode, cart.restored, cart.key]
      : [cart.mode, cart.restored],
    () => {
      if (mounted.value) void refresh();
    },
  );
  onBeforeUnmount(() => {
    disposed = true;
    ++sequence;
    controller?.abort();
  });
  const state = {
    pending,
    error,
    refresh,
    ready: computed(() => mounted.value && cart.quoteReady && !pending.value),
  };
  provide(quoteKey, state);
  return state;
}
