<template>
  <UButton
    class="favorite"
    :class="{ 'favorite--active': active }"
    :variant="active ? 'soft' : 'ghost'"
    :color="active ? 'error' : 'neutral'"
    :disabled="favorites.pending(product.id)"
    :aria-pressed="active"
    :aria-label="active ? 'Убрать из избранного' : 'Добавить в избранное'"
    @click.stop.prevent="toggle"
  >
    <template #leading>
      <UIcon name="i-lucide-heart" mode="svg" class="favorite__icon" aria-hidden="true" />
    </template>
  </UButton>
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
  width: 32px;
  height: 32px;
  min-width: 44px;
  min-height: 44px;
  flex-shrink: 0;
  justify-content: center;
  cursor: pointer;
  transition: transform 160ms ease, background-color 160ms ease, color 160ms ease;
}

.favorite:disabled {
  cursor: not-allowed;
}

.favorite:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: 2px;
}

.favorite__icon {
  width: 1.25rem;
  height: 1.25rem;
  flex-shrink: 0;
  transition: transform 160ms ease;
}

.favorite__icon :deep(path) {
  fill: none;
}

.favorite--active .favorite__icon :deep(path) {
  fill: currentColor;
}

@media (hover: hover) and (pointer: fine) {
  .favorite:not(:disabled):hover {
    background: var(--ui-bg-elevated);
  }

  .favorite:not(:disabled):hover .favorite__icon {
    transform: scale(1.08);
  }
}

.favorite:not(:disabled):active {
  transform: scale(0.96);
}

.favorite:not(:disabled):active .favorite__icon {
  transform: none;
}

@media (prefers-reduced-motion: reduce) {
  .favorite,
  .favorite__icon {
    transition: none;
  }

  .favorite:not(:disabled):active,
  .favorite:not(:disabled):hover .favorite__icon {
    transform: none;
  }
}
</style>
