<template>
  <article class="promo-card">
    <header class="promo-card__head"><h3 class="font-semibold">{{ promo.title }}</h3><UBadge :color="promo.status === 'AVAILABLE' ? 'success' : 'neutral'">{{ promoStatusLabels[promo.status] }}</UBadge></header>
    <code class="promo-card__code">{{ promo.code }}</code>
    <p class="font-medium">{{ promoDescription(promo) }}</p>
    <p class="text-sm">До {{ promoDate(promo.expiresAt) }} (МСК)</p>
    <p v-if="promo.minSubtotal" class="text-sm">От {{ money(promo.minSubtotal) }} за товары до скидки</p>
    <p class="text-sm text-muted">Одноразовый, только для вас. Скидка применяется к товарам. На доставку и дополнительные услуги скидка не распространяется.</p>
    <p v-if="reason" role="status" class="text-warning">{{ reason }}</p>
    <div class="promo-card__actions"><slot /></div>
  </article>
</template>

<script setup lang="ts">
import type { PersonalPromo } from '~/types/promo';
import { promoDate, promoDescription, promoStatusLabels } from '~/utils/promo';
import { money } from '~/utils/money';
defineProps<{ promo: PersonalPromo; reason?: string | null }>();
</script>

<style scoped>
.promo-card { display: grid; gap: 0.5rem; min-width: 0; padding: 1rem; border: 1px solid var(--ui-border); border-radius: 0.75rem; overflow-wrap: anywhere; }
.promo-card__head, .promo-card__actions { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; }
.promo-card__head h3 { flex: 1; min-width: 0; }
.promo-card__code { word-break: break-all; font-size: 0.875rem; }
.promo-card__actions :deep(button), .promo-card__actions :deep(a) { max-width: 100%; white-space: normal; }
</style>
