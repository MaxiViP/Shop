import { useCartStore } from "../stores/cart.ts";
import { nextCartQty, previousCartQty, validCartQty } from "../utils/cart.ts";
import type { ProductListItem } from "../types/product";

export function useCartActions() {
  const cart = useCartStore();

  async function put(product: ProductListItem, qty: number) {
    if (!cart.restored || !validCartQty(qty, product)) return false;
    const before = cart.qty(product.id);
    const changed = cart.mode === "guest"
      ? cart.put(product, qty)
      : await cart.changeServer({ kind: "set", productId: product.id, qty });
    if (changed && cart.qty(product.id) > before) cart.noteAddition();
    return changed;
  }

  async function add(product: ProductListItem) {
    if (!cart.restored) return false;
    const before = cart.qty(product.id);
    if (cart.mode === "guest") {
      const changed = cart.add(product);
      if (changed && cart.qty(product.id) > before) cart.noteAddition();
      return changed;
    }
    const next = nextCartQty(before || undefined, product);
    if (next === null) return false;
    const changed = await cart.changeServer({
      kind: "add", productId: product.id, qty: product.portionQty,
    });
    if (changed && cart.qty(product.id) > before) cart.noteAddition();
    return changed;
  }

  async function subtract(product: ProductListItem) {
    if (!cart.restored) return false;
    if (cart.mode === "guest") return cart.subtract(product);
    const previous = cart.qty(product.id);
    if (!previous) return false;
    const next = previousCartQty(previous, product);
    if (next === null) return false;
    return next === 0
      ? cart.changeServer({ kind: "remove", productId: product.id })
      : cart.changeServer({ kind: "set", productId: product.id, qty: next });
  }

  async function setQty(id: number, qty: number) {
    const product = cart.items.find((item) => item.product.id === id)?.product;
    return product ? put(product, qty) : false;
  }

  async function remove(id: number) {
    if (!cart.restored) return false;
    if (cart.mode === "guest") {
      cart.remove(id);
      return true;
    }
    return cart.changeServer({ kind: "remove", productId: id });
  }

  async function clear() {
    if (!cart.restored) return false;
    if (cart.mode === "guest") {
      cart.clear();
      return true;
    }
    return cart.changeServer({ kind: "clear" });
  }

  return { add, put, subtract, setQty, remove, clear };
}
