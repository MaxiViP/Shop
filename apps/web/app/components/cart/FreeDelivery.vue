<template>
  <div v-if="quote.enabled && quote.remaining !== null" class="free-delivery" role="status" aria-live="polite">
    <p class="free-delivery__text">{{ quote.eligible ? 'Бесплатная доставка' : `До бесплатной доставки осталось ${money(quote.remaining)}` }}</p>
    <div class="free-delivery__track" role="progressbar" aria-label="До бесплатной доставки" :aria-valuenow="quote.progress" aria-valuemin="0" aria-valuemax="100">
      <span class="free-delivery__progress" :style="{ width: `${quote.progress}%` }" />
    </div>
  </div>
</template>

<script setup lang="ts">
import type { DeliveryQuote } from '~/utils/cart';
import { money } from '~/utils/money';
defineProps<{ quote: DeliveryQuote }>();
</script>

<style scoped>
.free-delivery { display: grid; gap: 0.5rem; margin-block: 1rem; padding: 0.875rem; border-radius: 0.75rem; background: color-mix(in srgb, var(--ui-primary) 10%, var(--ui-bg)); }
.free-delivery__text { color: var(--ui-text); font-size: 0.875rem; font-weight: 600; }
.free-delivery__track { height: 0.375rem; overflow: hidden; border-radius: 999px; background: var(--ui-border); }
.free-delivery__progress { display: block; height: 100%; border-radius: inherit; background: var(--ui-primary); }
</style>
