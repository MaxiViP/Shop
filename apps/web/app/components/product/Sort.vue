<template>
  <UPopover v-model:open="open" :content="{ align: 'end', sideOffset: 8, onOpenAutoFocus: focusSort }">
    <UButton class="product-sort__toggle" type="button" icon="i-lucide-arrow-down-up" variant="soft" color="neutral" aria-label="Сортировка" :title="activeSort.label" aria-haspopup="menu" :aria-expanded="open" />
    <template #content>
      <div ref="panel" class="product-sort__panel" role="menu" aria-label="Сортировка товаров" aria-orientation="horizontal" @keydown="navigateSort">
        <button v-for="(option, index) in productSortOptions" :key="option.value" type="button" class="product-sort__option" role="menuitemradio" :aria-checked="sort === option.value" :tabindex="focus === index ? 0 : -1" @focus="focus = index" @click="chooseSort(option.value)">
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
  const element = panel.value, button = element?.querySelectorAll<HTMLButtonElement>('button')[focus.value];
  button?.focus({ preventScroll: true });
  if (element && button) element.scrollTo({ left: button.offsetLeft - (element.clientWidth - button.offsetWidth) / 2 });
}
</script>

<style scoped>
.product-sort__toggle { flex: none; width: var(--touch-target); height: var(--touch-target); padding: 0; }
.product-sort__panel { display: flex; gap: 0.25rem; width: min(36rem, calc(100vw - 2rem)); max-width: 100%; overflow-x: auto; padding: 0.375rem; overscroll-behavior-inline: contain; }
.product-sort__option { display: flex; flex: 1 0 5.5rem; flex-direction: column; align-items: center; justify-content: center; gap: 0.375rem; min-height: var(--touch-target); padding: 0.625rem 0.375rem; border-radius: 0.5rem; color: var(--ui-text-muted); cursor: pointer; }
.product-sort__option:hover { color: var(--ui-text); background: var(--ui-bg-elevated); }
.product-sort__option[aria-checked="true"] { color: var(--ui-primary); background: color-mix(in srgb, var(--ui-primary) 12%, var(--ui-bg)); }
.product-sort__option:focus-visible { outline: 2px solid var(--ui-primary); outline-offset: -2px; }
.product-sort__icon { width: 1.25rem; height: 1.25rem; flex: none; }
.product-sort__label { max-width: 7rem; text-align: center; font-size: 0.75rem; font-weight: 500; line-height: 1.25; }
</style>
