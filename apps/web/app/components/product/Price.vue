<template>
  <strong class="price"> {{ money(product.price) }} / {{ unit }} </strong>
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
  display: block;
  min-width: 0;
  font-size: 0.9375rem;
  line-height: 1.35;
  overflow-wrap: anywhere;
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
