<template>
  <UCard v-if="staff || extras.length" class="my-6">
    <template #header
      ><h2 class="text-xl font-semibold">Дополнительные услуги</h2></template
    >
    <div class="extras">
      <article v-for="extra in extras" :key="extra.id" class="extras__row">
        <div>
          <h3 class="font-semibold">{{ extra.title }}</h3>
          <p v-if="extra.comment" class="text-muted">{{ extra.comment }}</p>
          <p>
            {{ extra.quantity }} × {{ money(extra.unitPrice) }} =
            {{ money(extra.amount) }}
          </p>
          <UBadge v-if="extra.status === 'CANCELED'" color="neutral"
            >Отменена</UBadge
          >
        </div>
        <div v-if="editable && extra.status === 'ACTIVE'" class="flex gap-2">
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
        <UFormField label="Название" required
          ><UInput v-model="form.title" class="w-full" maxlength="120" required
        /></UFormField>
        <UFormField label="Комментарий"
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
        <p>Итого: {{ preview === null ? "—" : money(preview) }}</p>
        <div class="flex gap-2">
          <UButton type="submit" :loading="busy">Сохранить</UButton
          ><UButton variant="ghost" :disabled="busy" @click="open = false"
            >Закрыть</UButton
          >
        </div>
      </form>
    </div>
  </UCard>
</template>
<script setup lang="ts">
import type { OrderExtra } from "~/types/order";
const props = defineProps<{
  extras: OrderExtra[];
  staff?: boolean;
  editable?: boolean;
  orderId?: number;
}>();
const emit = defineEmits<{ refresh: [] }>();
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
function edit(extra?: OrderExtra) {
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
  if (busy.value || !props.editable) return;
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
.extras,
.extras__form {
  display: grid;
  gap: 1rem;
}
.extras__row {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 0.75rem;
  overflow-wrap: anywhere;
  border-bottom: 1px solid var(--ui-border);
  padding-bottom: 1rem;
}
.extras :deep(button) {
  min-height: 44px;
}
</style>
