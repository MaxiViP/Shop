<template>
  <div v-if="point" class="origin">
    <p>Где покупаем: <NuxtLink :to="`/market-map/${point.slug}`" class="origin__link">{{ point.name }}</NuxtLink></p>
    <p class="origin__note">Цена ориентировочная. Актуальную цену продавец подтвердит при сборке.</p>
  </div>
</template>

<script setup lang="ts">
import type { ProductListItem } from '~/types/product';
defineProps<{ point?: ProductListItem['marketPoint'] }>();
</script>

<style scoped>
.origin { display: grid; gap: .25rem; min-width: 0; font-size: .8125rem; line-height: 1.5; color: var(--ui-text-muted); overflow-wrap: anywhere; }
.origin__link { color: var(--ui-primary); text-decoration: underline; text-underline-offset: .15em; }
.origin__link:focus-visible { outline: 2px solid var(--ui-primary); outline-offset: 2px; }
.origin__note { font-size: .75rem; }
</style>
