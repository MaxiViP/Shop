<template>
  <div role="status" aria-label="Загружаем товары">
    <span class="sr-only">Загружаем товары…</span>
    <ProductGrid :items="[]">
      <div v-for="index in count" :key="index" class="product-skeleton" aria-hidden="true">
        <USkeleton class="product-skeleton__media" />
        <USkeleton class="product-skeleton__line" />
        <USkeleton class="product-skeleton__line product-skeleton__line--short" />
        <USkeleton class="product-skeleton__button" />
      </div>
    </ProductGrid>
  </div>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ count?: number }>(), { count: 12 });
</script>

<style scoped>
.product-skeleton { display: grid; gap: 0.75rem; min-width: 0; padding: 0.75rem; border: 1px solid var(--ui-border); border-radius: 0.75rem; }
.product-skeleton__media { width: 100%; aspect-ratio: 1; border-radius: 0.5rem; }
.product-skeleton__line { height: 1rem; width: 100%; }
.product-skeleton__line--short { width: 65%; }
.product-skeleton__button { margin-top: 0.5rem; height: var(--touch-target); }
</style>
