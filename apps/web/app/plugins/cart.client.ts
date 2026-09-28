import { defineNuxtPlugin } from "#app";
import { watch } from "vue";
import { useAuthStore } from "~/stores/auth";
import { useCartStore } from "~/stores/cart";
import { decodeCart, type CartItem, type ServerCartChange, type ServerCartSnapshot } from "~/utils/cart";

const key = "cart";
const mergeWarning = "Не удалось перенести гостевую корзину. Её товары сохранены в браузере; повторите вход или обновите страницу.";

export default defineNuxtPlugin((app) => {
  const cart = useCartStore();
  const auth = useAuthStore();
  const api = useApiClient();
  cart.bindServer({
    get: () => api<ServerCartSnapshot>("/cart"),
    change: (body: ServerCartChange & { revision: string }) =>
      api<ServerCartSnapshot>("/cart/change", { method: "POST", body }),
  });

  let started = false;
  let generation = 0;
  let pendingGuest: CartItem[] | null = null;

  function savedGuest() {
    try {
      return decodeCart(localStorage.getItem(key));
    } catch {
      return { items: [] as CartItem[], warning: "Не удалось прочитать сохранённую корзину: хранилище браузера недоступно." };
    }
  }

  async function activate() {
    const current = ++generation;
    const user = auth.user;
    if (user?.role !== "USER") {
      if (cart.mode === "guest" && cart.restored) return;
      const guest = savedGuest();
      cart.beginGuest();
      cart.restore(pendingGuest ?? guest.items, guest.warning);
      return;
    }
    const fromMemory = cart.mode === "guest" && cart.restored;
    const guest = fromMemory
      ? cart.items.map((item) => ({ product: item.product, qty: item.qty }))
      : pendingGuest ?? savedGuest().items;
    pendingGuest = guest.length ? guest : null;
    // Persist synchronous guest edits before the auth transition can suppress
    // the detached guest-only subscription.
    if (fromMemory) {
      try { localStorage.setItem(key, JSON.stringify({ version: 1, items: guest })); }
      catch { /* Keep pendingGuest in memory if storage is unavailable. */ }
    }
    cart.beginServer(user.id);
    try {
      let snapshot = await api<ServerCartSnapshot>("/cart");
      if (current !== generation) return;
      let warning = "";
      if (guest.length) {
        const items = guest.map((item) => ({ productId: item.product.id, qty: item.qty }));
        try {
          try {
            snapshot = await api<ServerCartSnapshot>("/cart/merge", {
              method: "POST", body: { revision: snapshot.revision, items },
            });
          } catch (cause) {
            if (typeof cause !== "object" || cause === null ||
                !("statusCode" in cause) || cause.statusCode !== 409) throw cause;
            snapshot = await api<ServerCartSnapshot>("/cart");
            snapshot = await api<ServerCartSnapshot>("/cart/merge", {
              method: "POST", body: { revision: snapshot.revision, items },
            });
          }
          if (current !== generation) return;
          pendingGuest = null;
          try { localStorage.removeItem(key); }
          catch { warning = mergeWarning; }
        } catch {
          warning = mergeWarning;
        }
      }
      if (current !== generation) return;
      cart.applyServer(snapshot, user.id);
      cart.storageWarning = warning;
    } catch {
      if (current === generation)
        cart.storageWarning = "Не удалось загрузить общую корзину. Повторите попытку.";
    }
  }

  function refreshWhenActive() {
    if (auth.user?.role !== "USER") return;
    if (!cart.restored) {
      void activate();
      return;
    }
    void cart.refreshServer();
  }

  app.hooks.hook("page:finish", () => {
    if (!started) {
      started = true;
      cart.$subscribe((_mutation, state) => {
        if (state.mode !== "guest" || !state.restored) return;
        try {
          localStorage.setItem(key, JSON.stringify({ version: 1, items: state.items }));
        } catch {
          // Storage may be denied/full. Keep the in-memory guest cart usable.
        }
      }, { detached: true });
      watch(() => [auth.user?.id, auth.user?.role], () => { void activate(); }, { flush: "sync" });
      window.addEventListener("focus", refreshWhenActive);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") refreshWhenActive();
      });
      void activate();
      return;
    }
    if (/^\/(cart|catalog|product)(\/|$)/.test(window.location.pathname))
      refreshWhenActive();
  });
});
