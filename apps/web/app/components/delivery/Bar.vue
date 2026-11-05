<template>
  <div class="delivery-bar">
    <UContainer>
      <button type="button" class="delivery-bar__button" aria-haspopup="dialog" @click="open = true">
        <UIcon name="i-lucide-map-pin" class="delivery-bar__icon" aria-hidden="true" />
        <span class="delivery-bar__address">{{ destination }}</span>
        <span class="delivery-bar__price" :title="delivery.error || undefined">
          {{ label }}<span v-if="delivery.stale && !free"> · уточняем</span>
        </span>
        <UIcon name="i-lucide-chevron-right" class="delivery-bar__icon" aria-hidden="true" />
      </button>
    </UContainer>
    <UModal
      v-model:open="open" title="Сколько стоит доставка?" description="Предварительная стоимость по вашему адресу."
      :ui="{ content: 'w-[calc(100%-1rem)] max-w-3xl max-h-[calc(100dvh-2rem)]', body: 'overflow-y-auto' }">
      <template #body><LazyDeliveryCalculator v-if="open" /></template>
      <template #footer><UButton to="/delivery" variant="link" @click="open = false">Все условия доставки</UButton></template>
    </UModal>
  </div>
</template>

<script setup lang="ts">
import { useDeliveryStore } from '~/stores/delivery';
import { useCartStore } from '~/stores/cart';
import { formatAddress } from '~/utils/address';
import { money } from '~/utils/money';
const delivery = useDeliveryStore();
const cart = useCartStore();
const open = ref(false);
const destination = computed(() => delivery.selected
  ? [delivery.selected.label, formatAddress(delivery.selected, false)].filter(Boolean).join(' · ')
  : 'Укажите адрес доставки');
const free = computed(() => cart.quoteReady && cart.quote?.valid && cart.quote.delivery?.eligible === true);
const label = computed(() => free.value ? 'Доставка бесплатно'
  : delivery.quote ? `Доставка ≈ ${money(delivery.quote.price)}`
    : delivery.pending ? 'Рассчитываем…' : delivery.error ? 'Повторить расчёт' : 'Узнать стоимость');
</script>

<style scoped>
.delivery-bar { border-bottom: 1px solid var(--ui-border); background: var(--ui-bg-elevated); }
.delivery-bar__button { display: flex; align-items: center; gap: 0.5rem; min-width: 0; width: 100%; min-height: 44px; padding-block: 0.5rem; text-align: left; cursor: pointer; font-size: 0.875rem; }
.delivery-bar__button:focus-visible { outline: 2px solid var(--ui-primary); outline-offset: -2px; border-radius: 0.5rem; }
.delivery-bar__address { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.delivery-bar__price { margin-left: auto; flex-shrink: 0; color: var(--ui-primary); font-weight: 600; }
.delivery-bar__icon { flex: none; width: 1rem; height: 1rem; }
@media (max-width: 25rem) { .delivery-bar__button { flex-wrap: wrap; } .delivery-bar__address { flex: 1; } .delivery-bar__price { margin-left: 1.5rem; } }
</style>
