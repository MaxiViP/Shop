<template>
  <nav class="categories">
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
  gap: 0.75rem;
  overflow-x: auto;
}

.categories__item {
  flex: none;
  padding: 0.65rem 1rem;
  border: 1px solid var(--ui-border);
  border-radius: 999px;
  transition: 0.2s;
}

.categories__item:hover {
  background: var(--ui-bg-muted);
}

.categories__item.router-link-exact-active {
  border-color: var(--ui-primary);
  color: var(--ui-primary);
}
</style>
