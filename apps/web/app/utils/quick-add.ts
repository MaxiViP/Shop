import type { ProductListItem } from "../types/product";
import { qtyText } from "./qty.ts";

export function quickAddState(
  product: Pick<ProductListItem, "name" | "unit" | "portionQty">,
  cartQty: number,
) {
  const added = cartQty > 0;
  const quantity = qtyText(product.unit, cartQty);
  const portion = qtyText(product.unit, product.portionQty);
  return {
    added,
    label: added ? quantity : "В корзину",
    ariaLabel: added
      ? `В корзине ${quantity}. Добавить ещё ${portion}`
      : `Добавить ${product.name} в корзину: ${portion}`,
  };
}
