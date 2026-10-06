<template>
  <div class="item-price">
    <UButton v-if="editable && !editing" size="sm" variant="soft" color="neutral" class="item-price__edit" @click="open">
      Изменить цену позиции
    </UButton>
    <form v-if="editable && editing" class="item-price__form" @submit.prevent="save">
      <p class="item-price__original">Цена заказа {{ money(item.price) }} / {{ qtyText(item.unit, item.priceQty) }}</p>
      <UFormField label="Фактическая цена продавца, ₽" help="Введите цену продавца без сервиса. Сервис KorzinaMarket рассчитается автоматически." class="item-price__field">
        <UInput v-model="rubles" type="text" inputmode="decimal" :disabled="busy || Boolean(retry)" maxlength="12" />
      </UFormField>
      <UFormField label="Причина (необязательно)" class="item-price__reason">
        <UInput v-model="reason" :disabled="busy || Boolean(retry)" maxlength="500" placeholder="Например, цена на рынке изменилась" />
      </UFormField>
      <p v-if="retry" class="item-price__error" role="alert">Не удалось подтвердить сохранение. Повторите тот же запрос или обновите заказ.</p>
      <div class="item-price__actions">
        <UButton type="submit" :loading="busy" :disabled="busy || disabled">{{ retry ? 'Повторить сохранение' : 'Сохранить цену' }}</UButton>
        <UButton type="button" variant="ghost" color="neutral" :disabled="busy" @click="cancel">Отмена</UButton>
      </div>
    </form>
  </div>
</template>

<script setup lang="ts">
import type { StaffOrderDetail } from '~/types/order';
import { apiError } from '~/utils/api-error';
import { kopecksToRubles, money, rublesToKopecks } from '~/utils/money';
import { qtyText } from '~/utils/qty';

const props = defineProps<{
  orderId: number;
  item: StaffOrderDetail['items'][number];
  editable: boolean;
  disabled: boolean;
}>();
const emit = defineEmits<{ refresh: []; busy: [value: boolean] }>();
const api = useApiClient();
const toast = useToast();
const editing = ref(false);
const busy = ref(false);
const rubles = ref('');
const reason = ref('');
const retry = ref<{ sellerPrice: number; reason?: string; requestId: string } | null>(null);

function open() {
  rubles.value = props.item.actualSellerPrice == null ? '' : kopecksToRubles(props.item.actualSellerPrice);
  reason.value = '';
  retry.value = null;
  editing.value = true;
}
function cancel() {
  editing.value = false;
  retry.value = null;
  emit('refresh');
}
async function save() {
  const sellerPrice = rublesToKopecks(rubles.value);
  if (!retry.value && sellerPrice === null) {
    toast.add({ title: 'Укажите положительную цену до 1 000 000 ₽', color: 'error' });
    return;
  }
  const body = retry.value ?? {
    sellerPrice: sellerPrice!, reason: reason.value.trim() || undefined, requestId: crypto.randomUUID(),
  };
  busy.value = true;
  emit('busy', true);
  try {
    await api(`/staff/orders/${props.orderId}/items/${props.item.id}/price`, { method: 'PATCH', body });
    retry.value = null;
    editing.value = false;
    emit('refresh');
    toast.add({ title: 'Фактическая цена сохранена' });
  } catch (error) {
    retry.value = body;
    toast.add({ title: 'Не удалось подтвердить изменение цены', description: apiError(error), color: 'error' });
  } finally {
    busy.value = false;
    emit('busy', false);
  }
}
</script>

<style scoped>
.item-price { display: grid; justify-items: start; gap: 0.4rem; }
.item-price__edit { min-height: var(--touch-target); }
.item-price__form {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 0.5rem;
  width: 100%;
  min-width: 0;
  padding: 0.65rem;
  border: 1px solid var(--ui-border);
  border-radius: 0.75rem;
  background: var(--ui-bg-elevated);
}
.item-price__original { color: var(--ui-text-muted); font-size: 0.8125rem; }
.item-price__field, .item-price__reason { min-width: 0; }
.item-price__field :deep(input), .item-price__reason :deep(input) { width: 100%; min-height: var(--touch-target); font-size: 1rem; }
.item-price__error { color: var(--ui-error); font-size: 0.875rem; }
.item-price__actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.item-price__actions :deep(button) { min-height: var(--touch-target); }
@media (min-width: 40rem) {
  .item-price__form { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .item-price__original, .item-price__actions, .item-price__error { grid-column: 1 / -1; }
}
</style>
