<template>
  <div v-if="point || note" class="origin">
    <p v-if="point">Где покупаем: <NuxtLink :to="`/market-map/${point.slug}`" class="origin__link">{{ point.name }}</NuxtLink></p>
    <p v-if="note" class="origin__note">{{ note }}</p>
  </div>
</template>

<script setup lang="ts">
import type { ProductListItem } from '~/types/product';
const props = defineProps<{ point?: ProductListItem['marketPoint']; priceStatus?: ProductListItem['priceStatus'] }>();
const note = computed(() => props.priceStatus === 'AUDITED' ? '' : props.priceStatus === 'SOURCE'
  ? 'Цена по открытому источнику и может измениться при сборке.'
  : 'Ориентировочная цена. Актуальную стоимость продавец подтвердит при сборке.');
</script>

<style scoped>
.origin { display: grid; gap: .25rem; min-width: 0; font-size: .8125rem; line-height: 1.5; color: var(--ui-text-muted); overflow-wrap: anywhere; }
.origin__link { color: var(--ui-primary); text-decoration: underline; text-underline-offset: .15em; }
.origin__link:focus-visible { outline: 2px solid var(--ui-primary); outline-offset: 2px; }
.origin__note { font-size: .75rem; }
</style>
