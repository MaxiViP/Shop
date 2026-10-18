<template>
  <nav class="breadcrumbs" :class="{ 'breadcrumbs--compact': compact }" aria-label="Хлебные крошки">
    <ol class="breadcrumbs__list">
      <li
        v-for="(item, index) in items"
        :key="item.to"
        class="breadcrumbs__item"
        :class="{
          'breadcrumbs__item--home': item.to === '/',
          'breadcrumbs__item--catalog': item.label === 'Каталог',
          'breadcrumbs__item--ancestor': index < items.length - 2,
        }"
      >
        <span v-if="index" class="breadcrumbs__separator" aria-hidden="true">/</span>
        <span v-if="index === items.length - 1" aria-current="page" :title="item.label">
          <span class="breadcrumbs__label">{{ item.label }}</span>
          <span v-if="compact && item.label === 'Каталог'" class="breadcrumbs__short" aria-hidden="true">Кат.</span>
        </span>
        <NuxtLink v-else :to="item.to" :aria-label="item.label" :title="item.label">
          <UIcon v-if="compact && item.to === '/'" name="i-lucide-house" class="breadcrumbs__home" aria-hidden="true" />
          <span class="breadcrumbs__label">{{ item.label }}</span>
          <span v-if="compact && item.label === 'Каталог'" class="breadcrumbs__short" aria-hidden="true">Кат.</span>
        </NuxtLink>
      </li>
    </ol>
  </nav>
</template>

<script setup lang="ts">
import type { Breadcrumb } from "~/utils/seo";
defineProps<{ items: Breadcrumb[]; compact?: boolean }>();
</script>

<style scoped>
.breadcrumbs { min-width: 0; grid-column: 1 / -1; margin-bottom: 0.75rem; }
.breadcrumbs__list { display: flex; flex-wrap: wrap; align-items: center; gap: 0.25rem 0.5rem; }
.breadcrumbs__item { display: flex; min-width: 0; align-items: center; gap: 0.5rem; font-size: 0.875rem; overflow-wrap: anywhere; }
.breadcrumbs__item a { display: inline-flex; align-items: center; min-height: 44px; color: var(--ui-primary); }
.breadcrumbs__item a:focus-visible { outline: 2px solid var(--ui-primary); outline-offset: 2px; }
.breadcrumbs__home, .breadcrumbs__short { display: none; }
@media (width < 40rem) {
  .breadcrumbs--compact .breadcrumbs__list { gap: 0.25rem; }
  .breadcrumbs--compact .breadcrumbs__item { gap: 0.25rem; font-size: 0.75rem; }
  .breadcrumbs--compact .breadcrumbs__item--ancestor { display: none; }
  .breadcrumbs--compact .breadcrumbs__item:nth-last-child(2) > .breadcrumbs__separator { display: none; }
  .breadcrumbs--compact .breadcrumbs__item--home a { justify-content: center; min-width: 1.75rem; }
  .breadcrumbs--compact .breadcrumbs__item--home .breadcrumbs__label { display: none; }
  .breadcrumbs--compact .breadcrumbs__home { display: block; width: 1rem; height: 1rem; }
}
@media (width < 23rem) {
  .breadcrumbs--compact .breadcrumbs__item--catalog .breadcrumbs__label { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
  .breadcrumbs--compact .breadcrumbs__short { display: inline; }
}
</style>
