<template>
  <section v-if="editable || extras.length" class="extras-card">
    <h2 class="extras-card__title">Дополнительные позиции и услуги</h2>
    <div class="extras">
      <p v-if="editable && limits" class="extras__limits">За единицу до {{ money(limits.maxOrderExtraUnitPrice) }} · Услуги {{ money(activeTotal) }} / {{ money(limits.maxOrderExtrasTotal) }}</p>
      <p v-if="editable && limitsError" class="text-error">Не удалось загрузить лимиты услуг. Обновите страницу.</p>
      <article v-for="extra in extras" :key="extra.id" class="extras__row">
        <div class="extras__description">
          <h3 class="font-semibold">{{ extra.title }}</h3>
          <p v-if="extra.comment" class="text-muted">{{ extra.comment }}</p>
          <p class="extras__amount">
            {{ extra.quantity }} × {{ money(extra.unitPrice) }} =
            {{ money(extra.amount) }}
          </p>
          <UBadge v-if="extra.status === 'CANCELED'" color="neutral"
            >Отменена</UBadge
          >
        </div>
        <div v-if="editable && extra.status === 'ACTIVE'" class="extras__actions">
          <UButton variant="ghost" :disabled="busy" @click="edit(extra)"
            >Изменить</UButton
          >
          <UButton
            variant="ghost"
            color="error"
            :disabled="busy"
            @click="cancel(extra)"
            >Отменить услугу</UButton
          >
        </div>
      </article>
      <UButton
        v-if="editable && !open"
        icon="i-lucide-plus"
        variant="outline"
        @click="edit()"
        >Добавить услугу</UButton
      >
      <form v-if="editable && open" class="extras__form" @submit.prevent="save">
        <UFormField label="Название" required class="extras__wide"
          ><AppTextInput v-model="form.title" class="w-full" maxlength="120" required
        /></UFormField>
        <UFormField label="Комментарий" class="extras__wide"
          ><UTextarea v-model="form.comment" class="w-full" maxlength="1000"
        /></UFormField>
        <UFormField label="Количество" required
          ><UInput
            v-model="form.quantity"
            type="number"
            min="1"
            max="10000"
            step="1"
            required
        /></UFormField>
        <UFormField label="Цена за единицу, ₽" required
          ><UInput v-model="form.price" inputmode="decimal" required
        /></UFormField>
        <p class="extras__wide">Итого: {{ preview === null ? "—" : money(preview) }}</p>
        <p v-if="limitError" class="extras__wide text-error" role="status">{{ limitError }}</p>
        <div class="extras__wide extras__actions">
          <UButton type="submit" :loading="busy" :disabled="!limits || !!limitError">Сохранить</UButton
          ><UButton variant="ghost" :disabled="busy" @click="open = false"
            >Закрыть</UButton
          >
        </div>
      </form>
    </div>
  </section>
</template>
<script setup lang="ts">
import type { OrderExtra } from "~/types/order";
import { extraLimitError, type ExtraLimits } from "~/utils/shop-settings";
const props = defineProps<{
  extras: OrderExtra[];
  staff?: boolean;
  editable?: boolean;
  orderId?: number;
}>();
const emit = defineEmits<{ refresh: [] }>();
const { data: limits, error: limitsError, refresh: refreshLimits } = await useApi<ExtraLimits>("/staff/extra-limits", { immediate: !!props.staff });
const activeTotal = computed(() => props.extras.filter(extra => extra.status === 'ACTIVE').reduce((sum, extra) => sum + extra.amount, 0));
const api = useApiClient();
const toast = useToast();
const open = ref(false);
const busy = ref(false);
const selected = ref<OrderExtra>();
const form = reactive({ title: "", comment: "", quantity: 1, price: "" });
const preview = computed(() => {
  const price = rublesToKopecks(form.price);
  const amount = price === null ? null : price * Number(form.quantity);
  return amount !== null &&
    Number.isSafeInteger(amount) &&
    amount > 0 &&
    amount <= 2147483647
    ? amount
    : null;
});
const limitError = computed(() => {
  const price = rublesToKopecks(form.price);
  return limits.value && price !== null && preview.value !== null ? extraLimitError(price, preview.value, activeTotal.value, selected.value, limits.value) : '';
});
function edit(extra?: OrderExtra) {
  void refreshLimits();
  selected.value = extra;
  Object.assign(form, {
    title: extra?.title ?? "",
    comment: extra?.comment ?? "",
    quantity: extra?.quantity ?? 1,
    price: extra ? kopecksToRubles(extra.unitPrice) : "",
  });
  open.value = true;
}
async function save() {
  if (busy.value || !props.editable || !limits.value || limitError.value) return;
  if (preview.value === null || !form.title.trim()) {
    toast.add({
      title: "Проверьте название, количество и цену",
      color: "error",
    });
    return;
  }
  busy.value = true;
  try {
    const extra = selected.value;
    await api(
      `/staff/orders/${props.orderId}/extras${extra ? `/${extra.id}` : ""}`,
      {
        method: extra ? "PATCH" : "POST",
        body: {
          title: form.title.trim(),
          comment: form.comment.trim(),
          quantity: Number(form.quantity),
          unitPrice: rublesToKopecks(form.price),
          ...(extra ? { version: extra.version } : {}),
        },
      },
    );
    open.value = false;
    emit("refresh");
  } catch (error) {
    toast.add({ title: apiError(error), color: "error" });
  } finally {
    busy.value = false;
  }
}
async function cancel(extra: OrderExtra) {
  if (busy.value || !props.editable) return;
  busy.value = true;
  try {
    await api(`/staff/orders/${props.orderId}/extras/${extra.id}/cancel`, {
      method: "POST",
      body: { version: extra.version },
    });
    if (selected.value?.id === extra.id) open.value = false;
    emit("refresh");
  } catch (error) {
    toast.add({ title: apiError(error), color: "error" });
  } finally {
    busy.value = false;
  }
}
</script>
<style scoped>
.extras-card {
  display: grid;
  gap: 0.5rem;
  min-width: 0;
  margin-block: 0.75rem;
  padding: 0.75rem;
  border: 1px solid var(--ui-border);
  border-radius: 0.875rem;
  background: var(--ui-bg);
}
.extras-card__title { font-size: 1rem; font-weight: 700; }
.extras { display: grid; gap: 0.5rem; }
.extras__limits { color: var(--ui-text-muted); font-size: 0.8125rem; line-height: 1.4; }
.extras__description { min-width: 0; }
.extras__amount { font-size: 0.875rem; }
.extras__form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.625rem;
}
.extras__wide { grid-column: 1 / -1; }
.extras__row {
  display: grid;
  gap: 0.35rem;
  overflow-wrap: anywhere;
  border-bottom: 1px solid var(--ui-border);
  padding-bottom: 0.5rem;
}
.extras__actions { display: flex; flex-wrap: wrap; gap: 0.25rem; }
.extras :deep(button) { min-height: var(--touch-target); }
@media (min-width: 40rem) {
  .extras-card { gap: 0.75rem; margin-block: 1.5rem; padding: var(--card-padding); }
  .extras__row { display: flex; justify-content: space-between; gap: 1rem; }
}
</style>
