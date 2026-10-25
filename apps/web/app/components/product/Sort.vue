<template>
  <UPopover v-model:open="open" :content="{ align: 'end', sideOffset: 8, collisionPadding: 0, onOpenAutoFocus: focusSort }" :ui="{ content: 'product-sort__content' }">
    <UButton class="product-sort__toggle" type="button" icon="i-lucide-arrow-down-up" variant="soft" color="neutral" aria-label="Сортировка" :title="activeSort.label" aria-haspopup="menu" :aria-expanded="open" />
    <template #content>
      <div ref="panel" class="product-sort__panel" role="menu" aria-label="Сортировка товаров" aria-orientation="horizontal" @keydown="navigateSort">
        <button v-for="(option, index) in productSortOptions" :key="option.value" type="button" class="product-sort__option" role="menuitemradio" :aria-checked="sort === option.value" :aria-label="option.label" :title="option.label" :tabindex="focus === index ? 0 : -1" @focus="focus = index" @click="chooseSort(option.value)">
          <UIcon :name="option.icon" class="product-sort__icon" aria-hidden="true" />
          <span class="product-sort__label">{{ option.label }}</span>
        </button>
      </div>
    </template>
  </UPopover>
</template>

<script setup lang="ts">
import type { ProductSort } from '~/types/product';
import { productSortOptions } from '~/composables/useProductSort';

const sort = defineModel<ProductSort>({ required: true });
const open = ref(false), panel = ref<HTMLElement | null>(null), focus = ref(0);
const activeSort = computed(() => productSortOptions.find(option => option.value === sort.value) ?? productSortOptions[0]!);
function chooseSort(value: ProductSort) { sort.value = value; open.value = false; }
function focusSort(event: Event) {
  event.preventDefault();
  focus.value = productSortOptions.findIndex(option => option.value === sort.value);
  void nextTick(() => panel.value?.querySelectorAll<HTMLButtonElement>('button')[focus.value]?.focus({ preventScroll: true }));
}
function navigateSort(event: KeyboardEvent) {
  const count = productSortOptions.length;
  if (['ArrowRight', 'ArrowDown'].includes(event.key)) focus.value = (focus.value + 1) % count;
  else if (['ArrowLeft', 'ArrowUp'].includes(event.key)) focus.value = (focus.value + count - 1) % count;
  else if (event.key === 'Home') focus.value = 0;
  else if (event.key === 'End') focus.value = count - 1;
  else return;
  event.preventDefault();
  const button = panel.value?.querySelectorAll<HTMLButtonElement>('button')[focus.value];
  button?.focus({ preventScroll: true });
}
</script>

<style scoped>
.product-sort__toggle { border: 1px solid var(--search-background); flex: none; width: var(--touch-target); height: var(--touch-target); padding: 0; }
:global(.product-sort__content) { width: 100vw; max-width: 100vw; }
.product-sort__panel { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 0.25rem; width: 100%; padding: 0.25rem; }
.product-sort__option { display: flex; min-width: 0; align-items: center; justify-content: center; gap: 0.375rem; min-height: var(--touch-target); padding: 0.375rem 0.25rem; border-radius: 0.5rem; color: var(--ui-text-muted); cursor: pointer; }
.product-sort__option:hover { color: var(--ui-text); background: var(--ui-bg-elevated); }
.product-sort__option[aria-checked="true"] { color: var(--ui-primary); background: color-mix(in srgb, var(--ui-primary) 12%, var(--ui-bg)); }
.product-sort__option:focus-visible { outline: 2px solid var(--ui-primary); outline-offset: -2px; }
.product-sort__icon { width: 1.25rem; height: 1.25rem; flex: none; }
.product-sort__label { max-width: 7rem; text-align: center; font-size: 0.75rem; font-weight: 500; line-height: 1.25; }
@media (width < 40rem) {
  .product-sort__option { min-height: 2.25rem; padding-block: 0.25rem; }
  .product-sort__label { display: none; }
}
</style>
