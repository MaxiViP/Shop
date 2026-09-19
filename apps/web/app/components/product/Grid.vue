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
  min-width: 0;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 21rem), 1fr));
  gap: 0.75rem;
}
</style>
