<template>
  <dl class="order-costs">
    <div><dt>Стоимость товаров{{ order.finalSubtotal === null ? ' (предварительно)' : ' и услуг' }}</dt><dd>{{ money(order.finalSubtotal ?? order.subtotal) }}</dd></div>
    <div v-if="order.promoCodeSnapshot" class="order-costs__discount"><dt>Скидка по промокоду<small>{{ order.promoTitleSnapshot }} · {{ order.promoCodeSnapshot }}</small></dt><dd>−{{ money(order.finalPromoDiscount ?? order.promoDiscount ?? 0) }}</dd></div>
    <div><dt>Доставка</dt><dd>{{ knownMoney(order.deliveryPrice, 'Уточняется') }}</dd></div>
    <div class="order-costs__total"><dt>Итог заказа</dt><dd>{{ knownMoney(order.finalTotal ?? order.total, 'После расчёта доставки') }}</dd></div>
  </dl>
</template>

<script setup lang="ts">
import type { OrderPromo } from '~/types/promo';
import { money, knownMoney } from '~/utils/money';
defineProps<{ order: OrderPromo & { subtotal: number; finalSubtotal: number | null; deliveryPrice: number | null; total: number | null; finalTotal: number | null } }>();
</script>

<style scoped>
.order-costs { display: grid; gap: 0.75rem; min-width: 0; }
.order-costs > div { display: flex; justify-content: space-between; gap: 0.75rem; align-items: baseline; flex-wrap: wrap; }
.order-costs dt { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.order-costs dd { font-weight: 600; }
.order-costs small { display: block; color: var(--ui-text-muted); font-size: 0.75rem; overflow-wrap: anywhere; }
.order-costs__discount { color: var(--ui-success); }
.order-costs__total { border-top: 1px solid var(--ui-border); padding-top: 0.75rem; }
</style>
