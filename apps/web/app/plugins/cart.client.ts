import { defineNuxtPlugin } from "#app";
import { useCartStore } from "~/stores/cart";

const key = "cart";

export default defineNuxtPlugin(() => {
  const cart = useCartStore();

  try {
    const data = localStorage.getItem(key);

    if (data) {
      const items = JSON.parse(data);

      if (Array.isArray(items)) {
        cart.restore(items);
      }
    }
  } catch {
    localStorage.removeItem(key);
  }

  cart.$subscribe((_mutation, state) => {
    localStorage.setItem(key, JSON.stringify(state.items));
  });
});
