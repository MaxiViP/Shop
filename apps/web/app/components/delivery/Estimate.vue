<template>
  <div class="estimate" aria-live="polite" :aria-busy="delivery.pending">
    <p v-if="free" class="estimate__price">Бесплатная доставка</p>
    <template v-else-if="delivery.quote">
      <p class="estimate__price">Доставка ≈ {{ money(delivery.quote.price) }}</p>
      <p class="estimate__note">
        {{ delivery.stale ? 'Предыдущая оценка' : 'Предварительно' }} · расчёт в {{ time }}
        <span v-if="delivery.pending"> · обновляем…</span>
      </p>
    </template>
    <p v-else-if="delivery.pending">Рассчитываем доставку…</p>
    <p v-else-if="!delivery.selected" class="estimate__note">Укажите адрес, чтобы узнать стоимость до покупок.</p>
    <p v-if="delivery.error && !free" class="estimate__error" role="status">{{ delivery.error }}</p>
    <UButton v-if="delivery.error && !free" variant="link" :loading="delivery.pending" @click="delivery.refresh(true)">Повторить расчёт</UButton>
    <p v-if="delivery.selected && !free" class="estimate__note">Ориентир для заказа весом 5 кг и размером 40 × 30 × 30 см. Итоговая стоимость зависит от заказа и тарифа при отправке; уточним после сборки перед оплатой доставки.</p>
  </div>
</template>

<script setup lang="ts">
import { useDeliveryStore } from '~/stores/delivery';
import { money } from '~/utils/money';
defineProps<{ free?: boolean }>();
const delivery = useDeliveryStore();
const time = computed(() => delivery.quote ? new Date(delivery.quote.calculatedAt).toLocaleTimeString('ru-RU', {
  timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit',
}) : '');
</script>

<style scoped>
.estimate { display: grid; gap: 0.5rem; min-width: 0; }
.estimate__price { font-size: 1.25rem; font-weight: 700; }
.estimate__note { color: var(--ui-text-muted); font-size: 0.875rem; line-height: 1.5; }
.estimate__error { color: var(--ui-error); font-size: 0.875rem; }
</style>
