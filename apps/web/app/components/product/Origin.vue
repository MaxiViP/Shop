<template>
  <div v-if="point || note" class="origin">
    <p v-if="point">Где покупаем: <NuxtLink :to="`/market-map/${point.slug}`" class="origin__link">{{ point.name }}</NuxtLink></p>
    <p v-if="priceStatus === 'SOURCE'" class="origin__note">{{ note }}</p>
    <details v-else-if="note" class="origin__disclosure">
      <summary class="origin__summary">
        <span>Ориентировочная цена.</span>
        <UIcon name="i-lucide-chevron-down" class="origin__chevron" aria-hidden="true" />
      </summary>
      <p class="origin__explanation">{{ note }}</p>
    </details>
  </div>
</template>

<script setup lang="ts">
import type { ProductListItem } from '~/types/product';
const props = defineProps<{ point?: ProductListItem['marketPoint']; priceStatus?: ProductListItem['priceStatus'] }>();
const note = computed(() => props.priceStatus === 'AUDITED' ? '' : props.priceStatus === 'SOURCE'
  ? 'Цена по открытому источнику и может измениться при сборке.'
  : 'Актуальную стоимость продавец подтвердит при сборке');
</script>

<style scoped>
.origin { display: grid; gap: .25rem; min-width: 0; font-size: .8125rem; line-height: 1.5; color: var(--ui-text-muted); overflow-wrap: anywhere; }
.origin__link { color: var(--ui-primary); text-decoration: underline; text-underline-offset: .15em; }
.origin__link:focus-visible { outline: 2px solid var(--ui-primary); outline-offset: 2px; }
.origin__note, .origin__disclosure { font-size: .75rem; }
.origin__summary { display: flex; align-items: baseline; gap: .25rem; width: fit-content; max-width: 100%; list-style: none; cursor: pointer; text-decoration: underline dotted; text-underline-offset: .2em; }
.origin__summary::-webkit-details-marker { display: none; }
.origin__summary:hover { color: var(--ui-primary); }
.origin__summary:focus-visible { outline: 2px solid var(--ui-primary); outline-offset: 2px; border-radius: .125rem; }
.origin__chevron { flex: none; align-self: center; width: .75rem; height: .75rem; transition: transform 200ms ease; }
.origin__disclosure[open] .origin__chevron { transform: rotate(180deg); }
.origin__explanation { padding-top: .25rem; }
@supports (interpolate-size: allow-keywords) {
  .origin__disclosure::details-content { interpolate-size: allow-keywords; block-size: 0; overflow: clip; transition: block-size 200ms ease, content-visibility 200ms allow-discrete; }
  .origin__disclosure[open]::details-content { block-size: auto; }
}
@media (prefers-reduced-motion: reduce) {
  .origin__chevron, .origin__disclosure::details-content { transition: none; }
}
</style>
