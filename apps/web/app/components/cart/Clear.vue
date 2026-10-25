<template>
  <UButton type="button" variant="ghost" color="neutral" :disabled="disabled" class="cart-clear" :aria-label="countdown === null ? 'Очистить корзину' : 'Отменить очистку корзины'" @click="toggleRemoval">
    <span v-if="countdown !== null" class="cart-clear__countdown" role="status" aria-live="polite">Отменить · {{ countdown }}</span>
    <span v-else>Очистить корзину</span>
  </UButton>
</template>

<script setup lang="ts">
import { useCartStore } from '~/stores/cart';

const props = defineProps<{ disabled?: boolean }>();
const emit = defineEmits<{ cleared: [] }>();
const cart = useCartStore();
const actions = useCartActions();
const notice = useHeaderNotice();
const countdown = ref<number | null>(null);
let timer: ReturnType<typeof setTimeout> | undefined;

function cancelRemoval() {
  clearTimeout(timer);
  timer = undefined;
  countdown.value = null;
}
function toggleRemoval() {
  if (countdown.value !== null) return cancelRemoval();
  if (props.disabled || !cart.count) return;
  countdown.value = 3;
  function tick() {
    if (props.disabled || !cart.count) return cancelRemoval();
    const remaining = countdown.value;
    if (remaining === null) return;
    if (remaining > 0) {
      countdown.value = remaining - 1;
      timer = setTimeout(tick, remaining === 1 ? 250 : 1000);
      return;
    }
    cancelRemoval();
    void actions.clear().then(success => {
      if (!success) return;
      emit('cleared');
      notice.show({ target: 'cart', text: 'Корзина очищена' });
    });
  }
  timer = setTimeout(tick, 1000);
}
watch(() => props.disabled, value => { if (value) cancelRemoval(); }, { flush: 'sync' });
watch(() => cart.count, value => { if (!value) cancelRemoval(); }, { flush: 'sync' });
onBeforeUnmount(cancelRemoval);
</script>

<style scoped>
.cart-clear { min-height: var(--touch-target); flex-shrink: 0; }
.cart-clear__countdown { color: var(--ui-error); font-weight: 700; font-variant-numeric: tabular-nums; animation: removal-blink 0.8s ease-in-out infinite; }
@keyframes removal-blink { 50% { opacity: 0.35; } }
@media (prefers-reduced-motion: reduce) { .cart-clear__countdown { animation: none; } }
</style>
