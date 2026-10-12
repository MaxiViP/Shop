import type { ProductListItem } from "../types/product";
import { qtyText } from "./qty.ts";

export function quickAddState(
  product: Pick<ProductListItem, "name" | "unit" | "portionQty"> & Partial<Pick<ProductListItem, 'priceUnit' | 'saleModel' | 'wholeLabel' | 'step'>>,
  cartQty: number,
) {
  const added = cartQty > 0;
  const quantity = qtyText(product.unit, cartQty, product);
  const portion = qtyText(product.unit, added ? product.step ?? product.portionQty : product.portionQty, product);
  const add = portion.replace(/1 упаковка$/, '1 упаковку').replace(/1 тушка$/, '1 тушку').replace(/1 рыба$/, '1 рыбу');
  return {
    added,
    label: added ? quantity : `Добавить ${add}`,
    ariaLabel: added
      ? `В корзине ${quantity}. Добавить ещё ${add}`
      : `Добавить ${product.name} в корзину: ${portion}`,
  };
}
