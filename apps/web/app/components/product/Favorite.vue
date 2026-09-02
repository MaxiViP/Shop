<template>
  <UButton
    class="favorite"
    :class="{ 'favorite--active': active }"
    icon="i-lucide-heart"
    :variant="active ? 'soft' : 'ghost'"
    :color="active ? 'error' : 'neutral'"
    :disabled="favorites.pending(product.id)"
    :aria-label="active ? 'Удалить из избранного' : 'Добавить в избранное'"
    @click.stop.prevent="toggle"
  />
</template>

<script setup lang="ts">
import type { ProductListItem } from "~/types/product";
import { useFavoritesStore } from "~/stores/favorites";

const { product } = defineProps<{
  product: ProductListItem;
}>();

const favorites = useFavoritesStore();
const toast = useToast();
const active = computed(() => favorites.has(product.id));

async function toggle() {
  try {
    await favorites.toggle(product);
  } catch (error) {
    toast.add({
      title: "Не удалось обновить избранное",
      description:
        error instanceof Error ? error.message : "Попробуйте ещё раз",
      color: "error",
    });
  }
}
</script>

<style scoped>
.favorite--active :deep(svg) {
  fill: currentColor;
}
</style>
