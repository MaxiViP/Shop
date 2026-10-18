import { useCartStore } from "../stores/cart.ts";
import { nextCartQty, previousCartQty, validCartQty } from "../utils/cart.ts";
import type { ProductListItem } from "../types/product";
import { compatibleQuantityUnit, variableWeight } from '../utils/sale.ts';

export function useCartActions() {
  const cart = useCartStore();

  async function put(product: ProductListItem, qty: number) {
    if (!cart.restored || !validCartQty(qty, product)) return false;
    const before = cart.qty(product.id);
    const item = cart.items.find(row => row.product.id === product.id);
    const changed = cart.mode === "guest"
      ? cart.put(product, qty)
      : await cart.changeServer({ kind: "set", productId: product.id, qty, quantityUnit: product.unit,
        weightMinGrams: variableWeight(product) ? item?.weightMinGrams : null, weightMaxGrams: variableWeight(product) ? item?.weightMaxGrams : null });
    if (changed && cart.qty(product.id) > before) cart.noteAddition();
    return changed;
  }

  async function add(product: ProductListItem) {
    if (!cart.restored) return false;
    const item = cart.items.find(row => row.product.id === product.id);
    if (item && !compatibleQuantityUnit(item.quantityUnit ?? item.product.unit, product)) return false;
    const before = cart.qty(product.id);
    if (cart.mode === "guest") {
      const changed = cart.add(product);
      if (changed && cart.qty(product.id) > before) cart.noteAddition();
      return changed;
    }
    const next = nextCartQty(before || undefined, product);
    if (next === null) return false;
    const changed = await cart.changeServer({
      kind: "add", productId: product.id, qty: next - before, quantityUnit: product.unit,
    });
    if (changed && cart.qty(product.id) > before) cart.noteAddition();
    return changed;
  }

  async function subtract(product: ProductListItem) {
    if (!cart.restored) return false;
    const item = cart.items.find(row => row.product.id === product.id);
    if (item && !compatibleQuantityUnit(item.quantityUnit ?? item.product.unit, product)) return false;
    if (cart.mode === "guest") return cart.subtract(product);
    const previous = cart.qty(product.id);
    if (!previous) return false;
    const next = previousCartQty(previous, product);
    if (next === null) return false;
    return next === 0
      ? cart.changeServer({ kind: "remove", productId: product.id })
      : cart.changeServer({ kind: "set", productId: product.id, qty: next, quantityUnit: product.unit });
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
  async function setWeightLimits(id: number, min: number | null, max: number | null) {
    const item = cart.items.find(row => row.product.id === id);
    if (!cart.restored || !item) return false;
    return cart.mode === 'guest' ? cart.setWeightLimits(id, min, max) : cart.changeServer({ kind: 'set', productId: id,
      qty: item.qty, quantityUnit: item.product.unit, weightMinGrams: min, weightMaxGrams: max });
  }

  async function clear() {
    if (!cart.restored) return false;
    if (cart.mode === "guest") {
      cart.clear();
      return true;
    }
    return cart.changeServer({ kind: "clear" });
  }

  return { add, put, subtract, setQty, setWeightLimits, remove, clear };
}
