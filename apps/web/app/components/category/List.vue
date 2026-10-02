<template>
  <nav class="categories" aria-label="Категории товаров">
    <NuxtLink :to="link('/catalog')" class="categories__item"> Все </NuxtLink>

    <NuxtLink
      v-for="item in items"
      :key="item.id"
      :to="link(`/catalog/${item.slug}`)"
      class="categories__item"
    >
      {{ item.name }}
    </NuxtLink>
  </nav>
</template>

<script setup lang="ts">
import type { Category } from "~/types/category";

const props = defineProps<{
  items: Category[];
  query?: Record<string, string>;
}>();

function link(path: string) {
  return props.query ? { path, query: props.query } : path;
}
</script>

<style scoped>
.categories {
  display: flex;
  gap: 0.5rem;
  overflow-x: auto;
  overscroll-behavior-inline: contain;
  scrollbar-width: thin;
  padding-block: 0.125rem;
}

.categories__item {
  display: inline-flex;
  min-height: var(--touch-target);
  align-items: center;
  flex: none;
  padding: 0.65rem 1rem;
  border: 1px solid var(--ui-border);
  border-radius: 999px;
  background: var(--ui-bg-elevated);
  font-weight: 500;
  transition: background-color 0.2s, border-color 0.2s, color 0.2s;
}

.categories__item:hover {
  border-color: var(--ui-primary);
  color: var(--ui-primary);
  background: color-mix(in srgb, var(--ui-primary) 8%, var(--ui-bg-elevated));
}

.categories__item.router-link-exact-active {
  border-color: var(--ui-primary);
  color: var(--ui-primary);
  background: color-mix(in srgb, var(--ui-primary) 12%, var(--ui-bg-elevated));
}

.categories__item:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: -2px;
}
</style>
