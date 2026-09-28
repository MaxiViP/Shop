import { defineNuxtPlugin } from "#app";
import { useCartStore } from "~/stores/cart";
import { decodeCart } from "~/utils/cart";

const key = "cart";

export default defineNuxtPlugin((app) => {
  const cart = useCartStore();
  // Restore after the initial page hydrates, even when root suspense is delayed.
  app.hooks.hookOnce("page:finish", () => {
    if (!cart.restored) {
      try {
        const { items, warning } = decodeCart(localStorage.getItem(key));
        cart.restore(items, warning);
      } catch {
        cart.restore(
          [],
          "Не удалось прочитать сохранённую корзину: хранилище браузера недоступно.",
        );
      }
    }
    cart.$subscribe(
      (_mutation, state) => {
        try {
          localStorage.setItem(
            key,
            JSON.stringify({ version: 1, items: state.items }),
          );
        } catch {
          /* Storage may be denied/full. Keep the in-memory cart usable. */
        }
      },
      { detached: true },
    );
  });
});
