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
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: clamp(0.5rem, 0.25rem + 0.8vw, 1rem);
}

@media (min-width: 40rem) {
  .grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (min-width: 48rem) {
  .grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}

@media (min-width: 64rem) {
  .grid {
    grid-template-columns: repeat(5, minmax(0, 1fr));
  }
}

@media (min-width: 80rem) {
  .grid {
    grid-template-columns: repeat(6, minmax(0, 1fr));
  }
}

@media (min-width: 96rem) {
  .grid {
    grid-template-columns: repeat(7, minmax(0, 1fr));
  }
}
</style>
