<template>
  <section v-if="cart.mode === 'server' && (selected || available)" class="promo-selector">
    <div v-if="selected" class="promo-selector__selection">
      <div><strong>{{ selected.title }}</strong><code>{{ selected.code }}</code></div>
      <strong>−{{ money(selected.discount) }}</strong>
      <p v-if="selected.reason" role="alert" class="text-warning">{{ selected.reason }}</p>
    </div>
    <div class="promo-selector__actions">
      <UButton type="button" icon="i-lucide-ticket" variant="outline" :disabled="cart.serverBusy" @click="show">{{ selected ? 'Изменить промокод' : 'Применить промокод' }}</UButton>
      <UButton v-if="selected" type="button" variant="ghost" color="neutral" :disabled="cart.serverBusy" @click="choose(null)">Убрать скидку</UButton>
    </div>
    <UModal v-model:open="open" title="Ваши промокоды" description="Можно применить один персональный промокод к этому заказу." :ui="{ content: 'w-[calc(100%-2rem)] max-w-xl' }">
      <template #body>
        <div class="promo-selector__list">
          <PromoCard v-for="promo in cart.quote?.promoCodes ?? []" :key="promo.id" :promo="promo" :reason="promo.reason">
            <p v-if="promo.eligible" class="text-sm">Скидка на текущие товары: {{ money(promo.discount) }}</p>
            <UButton type="button" :disabled="!promo.eligible || cart.serverBusy || !cart.quoteReady" :aria-pressed="selected?.id === promo.id" :loading="cart.serverBusy" @click="choose(promo.id)">{{ selected?.id === promo.id ? 'Выбран' : 'Применить' }}</UButton>
          </PromoCard>
          <p v-if="!cart.quote?.promoCodes?.length">Доступных промокодов сейчас нет.</p>
        </div>
      </template>
    </UModal>
  </section>
</template>

<script setup lang="ts">
import { money } from '~/utils/money';
const cart = useCartStore(), toast = useToast(), open = ref(false);
const selected = computed(() => cart.quote?.promo ?? null);
const available = computed(() => cart.quote?.promoCodes?.some(promo => promo.status === 'AVAILABLE') ?? false);
async function show() {
  open.value = true;
  if (!await cart.refreshServer()) toast.add({ title: 'Не удалось обновить условия промокодов', color: 'error' });
}
async function choose(promoCodeId: number | null) {
  if (cart.serverBusy) return;
  if (await cart.changeServer({ kind: 'promo', promoCodeId })) open.value = false;
  else toast.add({ title: 'Промокод не применён. Проверьте актуальные условия.', color: 'error' });
}
</script>

<style scoped>
.promo-selector { display: grid; gap: 0.75rem; margin-block: 1rem; min-width: 0; }
.promo-selector__selection { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: baseline; overflow-wrap: anywhere; }
.promo-selector__selection div { flex: 1; min-width: 0; }
.promo-selector__selection code { display: block; font-size: 0.75rem; word-break: break-all; }
.promo-selector__selection p { flex-basis: 100%; }
.promo-selector__actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }
.promo-selector__actions :deep(button) { max-width: 100%; white-space: normal; }
.promo-selector__list { display: grid; gap: 0.75rem; min-width: 0; max-height: 65dvh; overflow-y: auto; }
</style>
