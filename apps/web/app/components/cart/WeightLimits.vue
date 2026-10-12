<template>
  <div class="weight-limits">
    <UButton type="button" variant="link" color="neutral" @click="open = !open">{{ item.weightMinGrams || item.weightMaxGrams ? 'Ограничения веса' : 'Пожелания по весу' }}</UButton>
    <div v-if="open" class="weight-limits__form" role="group" aria-label="Пожелания по весу" @keydown.enter.prevent="save">
      <p>Вес каждого целого экземпляра, г. Наличие подходящего товара уточним при сборке; при отклонении попросим ваше решение в чате.</p>
      <div class="weight-limits__fields">
        <UFormField label="Не меньше, г"><UInput v-model="min" type="number" inputmode="numeric" min="1" max="1000000" step="1" /></UFormField>
        <UFormField label="Не больше, г"><UInput v-model="max" type="number" inputmode="numeric" min="1" max="1000000" step="1" /></UFormField>
      </div>
      <p v-if="error" class="text-error" role="alert">{{ error }}</p>
      <UButton type="button" :loading="busy" :disabled="busy" @click="save">Сохранить пожелание</UButton>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { CartItem } from '~/utils/cart';
const props = defineProps<{ item: CartItem }>();
const actions = useCartActions();
const open = ref(false);
const min = ref(props.item.weightMinGrams?.toString() ?? '');
const max = ref(props.item.weightMaxGrams?.toString() ?? '');
const error = ref('');
const busy = ref(false);
async function save() {
  if (busy.value) return;
  const lower = min.value === '' ? null : Number(min.value);
  const upper = max.value === '' ? null : Number(max.value);
  if ([lower, upper].some(value => value !== null && (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000)) ||
    (lower !== null && upper !== null && lower > upper)) { error.value = 'Укажите положительные целые граммы; минимум не больше максимума.'; return; }
  busy.value = true;
  const saved = await actions.setWeightLimits(props.item.product.id, lower, upper);
  busy.value = false;
  error.value = saved ? '' : 'Не удалось сохранить пожелание. Проверьте корзину.';
  if (saved) open.value = false;
}
</script>

<style scoped>
.weight-limits { min-width: 0; }
.weight-limits :deep(button) { min-height: var(--touch-target); white-space: normal; }
.weight-limits__form { display: grid; gap: 0.5rem; margin-block: 0.5rem; font-size: 0.875rem; }
.weight-limits__fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.5rem; }
.weight-limits__fields :deep(input) { width: 100%; min-height: var(--touch-target); }
</style>
