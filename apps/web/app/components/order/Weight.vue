<template>
  <div class="weight">
    <p>
      Допуск: ±{{ bpsPercent(bps) }}% · Без согласования:
      {{ qtyText("GRAM", range.min) }} – {{ qtyText("GRAM", range.max) }}
    </p>
    <p v-if="preview !== null">Стоимость: {{ money(preview) }}</p>
    <UAlert
      v-if="outside && !approved"
      color="warning"
      title="Требуется подтверждение покупателя"
      :description="`Отклонение ${deviation}%. До решения покупателя завершить сборку нельзя.`"
    />
    <p v-if="approved" class="text-success">Покупатель подтвердил этот вес</p>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{
  requested: number;
  actual: number;
  price: number;
  priceQty: number;
  bps: number;
  approved?: boolean;
}>();
const range = computed(() => weightRange(props.requested, props.bps));
const preview = computed(() => {
  try {
    return lineAmount(props.price, props.actual, props.priceQty);
  } catch {
    return null;
  }
});
const outside = computed(
  () =>
    preview.value !== null &&
    outsideTolerance("GRAM", props.requested, props.actual, props.bps),
);
const deviation = computed(() =>
  (((props.actual - props.requested) * 100) / props.requested).toLocaleString(
    "ru-RU",
    { maximumFractionDigits: 2, signDisplay: "always" },
  ),
);
</script>

<style scoped>
.weight {
  display: grid;
  gap: 0.5rem;
  margin-block: 0.75rem;
  font-size: 0.875rem;
  color: var(--ui-text-muted);
}
</style>
