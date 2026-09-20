<template>
  <nav class="breadcrumbs" aria-label="Хлебные крошки">
    <ol class="breadcrumbs__list">
      <li v-for="(item, index) in items" :key="item.to" class="breadcrumbs__item">
        <span v-if="index" aria-hidden="true">/</span>
        <span v-if="index === items.length - 1" aria-current="page">{{ item.label }}</span>
        <NuxtLink v-else :to="item.to">{{ item.label }}</NuxtLink>
      </li>
    </ol>
  </nav>
</template>

<script setup lang="ts">
import type { Breadcrumb } from "~/utils/seo";
defineProps<{ items: Breadcrumb[] }>();
</script>

<style scoped>
.breadcrumbs { min-width: 0; grid-column: 1 / -1; margin-bottom: 0.75rem; }
.breadcrumbs__list { display: flex; flex-wrap: wrap; align-items: center; gap: 0.25rem 0.5rem; }
.breadcrumbs__item { display: flex; min-width: 0; align-items: center; gap: 0.5rem; font-size: 0.875rem; overflow-wrap: anywhere; }
.breadcrumbs__item a { display: inline-flex; align-items: center; min-height: 44px; color: var(--ui-primary); }
.breadcrumbs__item a:focus-visible { outline: 2px solid var(--ui-primary); outline-offset: 2px; }
</style>
