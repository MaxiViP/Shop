<template>
  <article class="quick-item" :aria-labelledby="`quick-item-${product.id}`">
    <NuxtLink :to="`/product/${product.slug}`" class="quick-item__image" :aria-label="product.name">
      <ProductImage :image="product.images[0]" :alt="product.images[0]?.alt || product.name" context="compact" :identity="product.id">
        <UIcon name="i-lucide-carrot" aria-hidden="true" />
      </ProductImage>
    </NuxtLink>
    <div class="quick-item__body">
      <div class="quick-item__heading">
        <NuxtLink :id="`quick-item-${product.id}`" :to="`/product/${product.slug}`" class="quick-item__name">{{ product.name }}</NuxtLink>
        <fieldset class="quick-item__favorite" :disabled="disabled"><ProductFavorite :product="product" /></fieldset>
      </div>
      <ProductPrice :product="product" />
      <p v-if="variableWeight(product)" class="quick-item__hint">{{ product.unit === 'BUNCH' ? 'Количество в пучках' : 'Целиком, количество в штуках' }} · стоимость после взвешивания</p>
      <p v-if="problem" class="quick-item__error" role="status">{{ problem }}</p>
      <div class="quick-item__selection">
        <div v-if="qty" class="quick-item__counter" role="group" :aria-label="`${product.name}: в корзине ${quantity}`">
          <UButton color="neutral" variant="soft" icon="i-lucide-minus" :disabled="disabled || previous === null" :aria-label="problem ? `Удалить ${product.name} из корзины` : `Уменьшить ${product.name} на ${step}`" @click="change(previous)" />
          <button type="button" class="quick-item__quantity" :disabled="disabled" :aria-label="`Установить точное количество: ${product.name}`" @click="openEditor">
            <strong>{{ quantity }}</strong><span>изменить</span>
          </button>
          <UButton color="neutral" variant="soft" icon="i-lucide-plus" :disabled="disabled || Boolean(problem) || next === null" :aria-label="`Добавить ${step}: ${product.name}`" @click="change(next)" />
        </div>
        <div v-else class="quick-item__add">
          <UButton :disabled="disabled || Boolean(problem)" icon="i-lucide-plus" @click="change(suggestedQty)">Добавить {{ suggestedQuantity }}</UButton>
          <UButton color="neutral" variant="ghost" :disabled="disabled || Boolean(problem)" :aria-label="`Другое количество: ${product.name}`" @click="openEditor">Другое</UButton>
        </div>
        <div class="quick-item__total">
          <strong>{{ problem ? 'Проверьте товар' : amount === null ? 'После взвешивания' : `≈ ${money(amount)}` }}</strong>
          <span>{{ qty ? 'за выбранное количество' : `за ${suggestedQuantity}` }}</span>
        </div>
      </div>
      <div v-if="message" class="quick-item__receipt" role="status" aria-live="polite">
        <p>{{ message }}</p><UButton v-if="undo" color="neutral" variant="outline" size="sm" :disabled="disabled" :aria-label="`Вернуть предыдущее количество: ${product.name}`" @click="emit('undo')">Вернуть</UButton>
      </div>
      <form v-if="editing" class="quick-item__editor" @submit.prevent="submit">
        <label :for="`quick-qty-${product.id}`">{{ product.unit === 'GRAM' ? 'Общее количество, граммы' : 'Общее количество, целое число' }}</label>
        <div class="quick-item__input">
          <input :id="`quick-qty-${product.id}`" v-model="draft" type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" :disabled="disabled" :aria-describedby="`quick-terms-${product.id}`">
          <UButton type="submit" :disabled="disabled">Сохранить</UButton>
          <UButton type="button" color="neutral" variant="ghost" :disabled="disabled" aria-label="Закрыть ввод количества" icon="i-lucide-x" @click="editing = false" />
        </div>
        <p :id="`quick-terms-${product.id}`" class="quick-item__hint">От {{ minimum }}, шаг {{ step }}. {{ qty ? '0 — удалить товар.' : '' }}</p>
        <p v-if="error" class="quick-item__error" role="alert">{{ error }}</p>
      </form>
    </div>
  </article>
</template>

<script setup lang="ts">
import type { ProductListItem } from '~/types/product';
import type { CartQuoteLine } from '~/utils/cart';
import { cartLineMessage, nextCartQty, previousCartQty, validCartQty } from '~/utils/cart';
import { money } from '~/utils/money';
import { qtyText } from '~/utils/qty';
import { variableWeight } from '~/utils/sale';

const props = defineProps<{
  product: ProductListItem;
  qty: number;
  line?: CartQuoteLine;
  suggestedQty: number;
  suggestedTotal: number | null;
  disabled: boolean;
  message?: string;
  undo?: boolean;
}>();
const emit = defineEmits<{ change: [qty: number]; undo: [] }>();
const editing = ref(false);
const draft = ref('');
const error = ref('');
const quantityUnit = computed(() => props.line?.quantityUnit ?? props.product.unit);
const quantity = computed(() => qtyText(quantityUnit.value, props.qty, props.product));
const suggestedQuantity = computed(() => qtyText(props.product.unit, props.suggestedQty, props.product));
const step = computed(() => qtyText(props.product.unit, props.product.step, props.product));
const minimum = computed(() => qtyText(props.product.unit, props.product.min, props.product));
const previous = computed(() => props.qty ? props.line && props.line.status !== 'AVAILABLE' ? 0 : previousCartQty(props.qty, props.product) : null);
const next = computed(() => nextCartQty(props.qty || undefined, props.product));
const amount = computed(() => props.qty ? props.line?.lineTotal ?? null : props.suggestedTotal);
const problem = computed(() => cartLineMessage(props.line));

function openEditor() {
  draft.value = String(props.qty || props.suggestedQty);
  error.value = '';
  editing.value = true;
}
function change(qty: number | null) {
  if (props.disabled || qty === null) return;
  if (qty !== 0 && !validCartQty(qty, props.product)) return;
  emit('change', qty);
}
function submit() {
  const input = draft.value.trim();
  const qty = /^\d+$/.test(input) ? Number(input) : NaN;
  if (!Number.isSafeInteger(qty) || (qty === 0 ? !props.qty : !validCartQty(qty, props.product))) {
    error.value = `Введите целое число: от ${minimum.value}, шаг ${step.value}${props.qty ? ', либо 0 для удаления' : ''}.`;
    return;
  }
  if (props.disabled) return;
  change(qty);
  editing.value = false;
}
</script>

<style scoped>
.quick-item { display: grid; grid-template-columns: 4.25rem minmax(0, 1fr); gap: 0.875rem; min-width: 0; padding-block: 1.125rem; border-bottom: 1px solid var(--ui-border); }
.quick-item__image { display: flex; align-items: center; justify-content: center; align-self: start; aspect-ratio: 1; overflow: hidden; border-radius: 0.875rem; background: var(--ui-bg-elevated); color: var(--ui-text-muted); }
.quick-item__image :deep(img) { width: 100%; height: 100%; object-fit: cover; }
.quick-item__image :deep(svg) { width: 1.5rem; height: 1.5rem; }
.quick-item__body { min-width: 0; }
.quick-item__heading { display: flex; align-items: start; justify-content: space-between; gap: 0.375rem; }
.quick-item__name { padding-top: 0.375rem; font-size: 1rem; font-weight: 650; line-height: 1.35; overflow-wrap: anywhere; }
.quick-item__favorite { margin: 0; padding: 0; border: 0; flex: none; }
.quick-item__selection { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 0.75rem; margin-top: 0.875rem; }
.quick-item__counter { display: flex; align-items: center; gap: 0.375rem; }
.quick-item__counter :deep(button) { min-width: 2.75rem; min-height: 2.75rem; justify-content: center; }
.quick-item__quantity { display: grid; justify-items: center; min-width: 5rem; padding-inline: 0.25rem; background: none; border: 0; color: var(--ui-text); cursor: pointer; }
.quick-item__quantity strong { font-size: 1rem; font-variant-numeric: tabular-nums; }
.quick-item__quantity span, .quick-item__total span { font-size: 0.6875rem; color: var(--ui-text-muted); }
.quick-item__quantity:focus-visible { outline: 2px solid var(--ui-primary); outline-offset: 2px; border-radius: 0.25rem; }
.quick-item__quantity:disabled { cursor: default; opacity: 0.5; }
.quick-item__add { display: flex; align-items: center; flex-wrap: wrap; gap: 0.25rem; }
.quick-item__add :deep(button) { min-height: 2.75rem; }
.quick-item__total { display: grid; min-width: 0; gap: 0.125rem; }
.quick-item__total strong { font-size: 0.9375rem; font-weight: 650; font-variant-numeric: tabular-nums; }
.quick-item__hint { margin-top: 0.375rem; font-size: 0.75rem; line-height: 1.45; color: var(--ui-text-muted); }
.quick-item__receipt { display: flex; align-items: center; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.75rem; padding: 0.625rem; border: 1px solid var(--ui-primary); border-radius: 0.625rem; background: var(--ui-bg-elevated); font-size: 0.8125rem; line-height: 1.5; font-variant-numeric: tabular-nums; }
.quick-item__receipt p { flex: 1 1 12rem; }
.quick-item__receipt :deep(button) { min-height: 2.75rem; flex: none; }
.quick-item__editor { display: grid; gap: 0.375rem; margin-top: 0.875rem; }
.quick-item__editor label { font-size: 0.8125rem; font-weight: 500; }
.quick-item__input { display: flex; align-items: center; gap: 0.375rem; }
.quick-item__input input { width: 100%; min-width: 0; min-height: 2.75rem; padding: 0.5rem 0.625rem; border: 1px solid var(--ui-border-accented); border-radius: 0.5rem; background: var(--ui-bg); color: var(--ui-text); font-size: 1rem; }
.quick-item__input :deep(button) { flex: none; min-height: 2.75rem; }
.quick-item__error { margin-top: 0.375rem; color: var(--ui-error); font-size: 0.8125rem; line-height: 1.45; }
@media (max-width: 24rem) { .quick-item { grid-template-columns: 3rem minmax(0, 1fr); gap: 0.625rem; } .quick-item__input { flex-wrap: wrap; } .quick-item__input input { flex-basis: 100%; } }
</style>
