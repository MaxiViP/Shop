<template>
  <div ref="root" class="grid" :data-windowed="windowed || undefined">
    <slot>
      <div v-if="top" class="grid__spacer" :style="{ height: `${top}px` }" aria-hidden="true" />
      <ProductCard
        v-for="(product, index) in visible"
        :key="product.id"
        :product="product"
        :compact="compact"
        :data-product-index="start + index"
      />
      <div v-if="bottom" class="grid__spacer" :style="{ height: `${bottom}px` }" aria-hidden="true" />
    </slot>
  </div>
</template>

<script setup lang="ts">
import type { ProductListItem } from "~/types/product";

const props = defineProps<{
  items: ProductListItem[];
  compact?: boolean;
  windowed?: boolean;
}>();
const root = ref<HTMLElement | null>(null);
const { start, end, top, bottom } = useGridWindow(root, () => props.items.length, () => !!props.windowed);
const visible = computed(() => props.items.slice(start.value, props.windowed ? end.value : undefined));
</script>

<style scoped>
.grid {
  display: grid;
  min-width: 0;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.375rem;
}
.grid__spacer { grid-column: 1 / -1; pointer-events: none; }
.grid[data-windowed] { overflow-anchor: none; }

@media (min-width: 40rem) {
  .grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.5rem;
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
    gap: 0.75rem;
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
