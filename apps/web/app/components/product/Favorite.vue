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
const notice = useHeaderNotice();
const active = computed(() => favorites.has(product.id));

async function toggle() {
  if (favorites.pending(product.id)) return;
  const wasFavorite = active.value;
  try {
    await favorites.toggle(product);
    notice.show({
      target: 'favorites',
      text: wasFavorite ? 'Удалено из избранного' : 'Добавлено в избранное',
    });
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
.favorite {
  min-width: var(--touch-target);
  min-height: var(--touch-target);
}

.favorite--active :deep(svg) {
  fill: currentColor;
}
</style>
