<template>
  <div class="whole-weight">
    <p>Взвесьте каждый целый экземпляр. Оплата по фактическому весу.</p>
    <p v-if="item.weightMinGrams || item.weightMaxGrams">Ограничение покупателя на каждый экземпляр: {{ item.weightMinGrams ? `от ${qtyText('GRAM', item.weightMinGrams)}` : '' }} {{ item.weightMaxGrams ? `до ${qtyText('GRAM', item.weightMaxGrams)}` : '' }}. Если не подходит, согласуйте замену в чате.</p>
    <div v-if="editable" class="whole-weight__inputs">
      <UFormField v-for="(_, index) in weights" :key="index" :label="`Вес экземпляра ${index + 1}, г`">
        <UInput v-model.number="weights[index]" type="number" inputmode="numeric" min="1" max="1000000" step="1" class="w-full" />
      </UFormField>
    </div>
    <p v-else-if="item.pieceWeights?.length">Вес экземпляров: {{ item.pieceWeights.map(weight => qtyText('GRAM', weight)).join(' + ') }}</p>
    <p v-if="totalWeight">Общий вес: {{ qtyText('GRAM', totalWeight) }}. {{ preview === null ? '' : `Стоимость: ${money(preview)}` }}</p>
  </div>
</template>

<script setup lang="ts">
import type { OrderDetail } from '~/types/order';
import { qtyText } from '~/utils/qty';
import { money } from '~/utils/money';
import { lineAmount } from '~/utils/assembly';
const props = defineProps<{ item: OrderDetail['items'][number]; count: number; editable: boolean }>();
const weights = defineModel<number[]>({ required: true });
watch(() => [props.count, props.editable, weights.value.length] as const, ([count]) => {
  if (!props.editable || !Number.isSafeInteger(count) || count < 1 || count > 100) return;
  if (weights.value.length === count) return;
  weights.value = Array.from({ length: count }, (_, index) => (weights.value ?? [])[index] ?? 0);
}, { immediate: true });
const totalWeight = computed(() => (props.editable ? weights.value : props.item.pieceWeights ?? []).reduce((sum, weight) => sum + Number(weight), 0));
const preview = computed(() => {
  try { return lineAmount(props.item.actualPrice ?? props.item.price, totalWeight.value, props.item.priceQty); }
  catch { return null; }
});
</script>

<style scoped>
.whole-weight { display: grid; gap: 0.5rem; font-size: 0.875rem; color: var(--ui-text-muted); }
.whole-weight__inputs { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 10rem), 1fr)); gap: 0.5rem; }
.whole-weight__inputs :deep(input) { min-height: var(--touch-target); }
</style>
