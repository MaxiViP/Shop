<template>
  <div v-if="order.promoCodeSnapshot" class="order-promo">
    <span>Скидка по промокоду<span class="order-promo__code">{{ order.promoTitleSnapshot }} · {{ order.promoCodeSnapshot }}</span></span>
    <strong>−{{ money(order.finalPromoDiscount ?? order.promoDiscount ?? 0) }}</strong>
  </div>
</template>

<script setup lang="ts">
import type { OrderPromo } from '~/types/promo';
import { money } from '~/utils/money';
defineProps<{ order: OrderPromo }>();
</script>

<style scoped>
.order-promo { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: 0.5rem; margin-block: 0.75rem; color: var(--ui-success); overflow-wrap: anywhere; }
.order-promo > span { flex: 1; min-width: 0; }
.order-promo__code { display: block; font-size: 0.75rem; color: var(--ui-text-muted); word-break: break-all; }
</style>
