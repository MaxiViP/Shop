import { computed, ref } from "vue";
import { defineStore } from "pinia";
import type { Product } from "~/types/product";

export interface CartItem {
  product: Product;
  qty: number;
}

export const useCartStore = defineStore("cart", () => {
  const items = ref<CartItem[]>([]);

  const count = computed(() => items.value.length);

  const total = computed(() =>
    items.value.reduce((sum, item) => sum + lineTotal(item), 0),
  );

  function lineTotal(item: CartItem) {
    return Math.round((item.product.price * item.qty) / item.product.priceQty);
  }

  function add(product: Product, qty = product.min) {
    const item = items.value.find((item) => item.product.id === product.id);

    if (item) {
      item.qty += qty;
      return;
    }

    items.value.push({
      product,
      qty,
    });
  }

  function setQty(id: number, qty: number) {
    const item = items.value.find((item) => item.product.id === id);

    if (!item) return;

    item.qty = Math.max(item.product.min, qty);
  }

  function remove(id: number) {
    items.value = items.value.filter((item) => item.product.id !== id);
  }

  function clear() {
    items.value = [];
  }

  function restore(value: CartItem[]) {
    items.value = value;
  }

  return {
    items,
    count,
    total,
    lineTotal,
    add,
    setQty,
    remove,
    clear,
    restore,
  };
});
