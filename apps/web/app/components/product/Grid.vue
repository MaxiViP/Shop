<template>
  <div class="grid">
    <ProductCard
      v-for="product in items"
      :key="product.id"
      :product="product"
    />
  </div>
</template>

<script setup lang="ts">
import type { ProductListItem } from "~/types/product";

defineProps<{
  items: ProductListItem[];
}>();
</script>

<style scoped>
.grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 1rem;
}

@media (max-width: 1024px) {
  .grid {
    grid-template-columns: repeat(3, 1fr);
  }
}

@media (max-width: 768px) {
  .grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (max-width: 480px) {
  .grid {
    grid-template-columns: 1fr;
  }
}
</style>
