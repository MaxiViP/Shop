<template>
  <div class="delivery-minimum">
    <UAlert
      v-if="!settings"
      color="warning"
      title="Не удалось загрузить условия получения заказа. Обновите страницу."
    />
    <UAlert
      v-else-if="!settings.deliveryEnabled"
      color="neutral"
      title="Доставка временно недоступна."
    />
    <div
      v-else-if="eligibility && eligibility.remaining > 0"
      class="delivery-minimum__notice"
    >
      <p class="font-semibold">
        Минимальная сумма для доставки —
        {{ money(settings.minDeliverySubtotal) }}
      </p>
      <p>В корзине: {{ money(subtotal) }}</p>
      <p>
        До доставки осталось добавить товаров на
        {{ money(eligibility.remaining) }}
      </p>
      <progress
        class="delivery-minimum__bar"
        :value="eligibility.progress"
        max="100"
        aria-label="Сумма товаров до минимального заказа для доставки"
      />
      <p v-if="settings.pickupEnabled" class="text-muted">
        Или выберите самовывоз.
      </p>
    </div>
  </div>
</template>
<script setup lang="ts">
import {
  deliveryEligibility,
  type PublicShopSettings,
} from "~/utils/shop-settings";
const props = defineProps<{
  settings: PublicShopSettings | null | undefined;
  subtotal: number;
}>();
const eligibility = computed(() =>
  props.settings ? deliveryEligibility(props.subtotal, props.settings) : null,
);
</script>
<style scoped>
.delivery-minimum__notice {
  display: grid;
  gap: 0.5rem;
  padding: 1rem;
  border: 1px solid var(--ui-border);
  border-radius: 0.75rem;
}
.delivery-minimum__bar {
  width: 100%;
  height: 0.375rem;
  border: 0;
  border-radius: 1rem;
  overflow: hidden;
  background: var(--ui-border);
  color: var(--ui-primary);
}
.delivery-minimum__bar::-webkit-progress-bar {
  background: var(--ui-border);
}
.delivery-minimum__bar::-webkit-progress-value {
  background: var(--ui-primary);
}
.delivery-minimum__bar::-moz-progress-bar {
  background: var(--ui-primary);
}
</style>
