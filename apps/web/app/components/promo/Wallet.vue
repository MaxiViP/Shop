<template>
  <section class="promo-wallet">
    <header><h2 class="text-xl font-semibold">Мои промокоды</h2><p class="text-muted">Персональные скидки для следующих покупок.</p></header>
    <UAlert v-if="error" color="error" :title="apiError(error)" :actions="[{ label: 'Повторить', onClick: () => refresh() }]" />
    <p v-else-if="pending">Загрузка…</p>
    <p v-else-if="!data?.length" class="text-muted">У вас пока нет персональных промокодов.</p>
    <div class="promo-wallet__list">
      <PromoCard v-for="promo in data ?? []" :key="promo.id" :promo="promo">
        <UButton v-if="promo.status === 'AVAILABLE'" to="/cart" variant="outline">Использовать в корзине</UButton>
        <UButton v-if="promo.usedOrder" :to="'/order/' + promo.usedOrder.publicId" variant="link">Заказ с промокодом</UButton>
        <span v-if="promo.usedAt" class="text-sm text-muted">Использован {{ promoDate(promo.usedAt) }} (МСК)</span>
      </PromoCard>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { PersonalPromo } from '~/types/promo';
import { promoDate } from '~/utils/promo';
const auth = useAuthStore();
const { data, error, pending, refresh } = await useApi<PersonalPromo[]>('/promo-codes', { key: 'personal-promos-' + auth.user?.id });
</script>

<style scoped>
.promo-wallet { display: grid; gap: 1rem; min-width: 0; }
.promo-wallet__list { display: grid; gap: 0.75rem; min-width: 0; }
@media (min-width: 48rem) { .promo-wallet__list { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
