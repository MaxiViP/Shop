<template>
  <strong class="price">
    <span>{{ money(product.price) }}</span>
    <span class="price__unit">/ {{ unit }}</span>
  </strong>
</template>

<script setup lang="ts">
import type { ProductListItem } from "~/types/product";
import { money } from "~/utils/money";

const { product } = defineProps<{
  product: ProductListItem;
}>();

const unit = computed(() => {
  if (product.unit === "GRAM") {
    return product.priceQty === 1000 ? "кг" : `${product.priceQty} г`;
  }

  return {
    PIECE: "шт.",
    BUNCH: "пучок",
    PACK: "уп.",
  }[product.unit];
});
</script>

<style scoped>
.price {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  column-gap: 0.25em;
  min-width: 0;
  font-size: 0.9375rem;
  line-height: 1.35;
  overflow-wrap: anywhere;
}

.price__unit {
  color: var(--ui-text-muted);
  font-size: 0.875rem;
  font-weight: 400;
}

@media (min-width: 40rem) {
  .price {
    font-size: 1rem;
  }
}

@media (min-width: 64rem) {
  .price {
    font-size: 1.125rem;
  }
}
</style>
