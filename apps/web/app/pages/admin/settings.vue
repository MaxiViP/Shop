<template>
  <section class="space-y-6">
    <h2 class="text-2xl font-semibold">Настройки</h2>
    <UAlert v-if="error" color="error" title="Не удалось загрузить настройки" />
    <p v-if="pending">Загрузка…</p>
    <UCard v-else-if="data">
      <template #header><h3 class="font-semibold">Сборка заказов</h3></template>
      <form class="space-y-4 max-w-xl" @submit.prevent="save">
        <UFormField label="Допустимое отклонение веса, %" required>
          <UInput
            v-model="percent"
            inputmode="decimal"
            required
            :disabled="busy"
          />
        </UFormField>
        <p class="text-muted">
          Если фактический вес товара отличается от заказанного не больше
          указанного значения, дополнительное подтверждение покупателя не
          требуется. От 0 до 50%. Изменение применяется только к новым заказам.
        </p>
        <h3 class="font-semibold">Уведомления</h3>
        <UFormField label="Время ожидания ответа покупателя, мин." required>
          <UInput v-model.number="responseMinutes" type="number" min="1" max="120" step="1" :disabled="busy" />
        </UFormField>
        <p class="text-muted">От 1 до 120 минут. После этого продавцу предлагается позвонить покупателю. Автоматических повторных SMS нет.</p>
        <UButton type="submit" :loading="busy">Сохранить</UButton>
      </form>
    </UCard>
  </section>
</template>

<script setup lang="ts">
definePageMeta({ layout: "admin", middleware: "admin" });
const { data, pending, error, refresh } = await useApi<{
  weightToleranceBps: number;
  customerResponseMinutes: number;
}>("/admin/settings");
const percent = ref(
  data.value ? bpsPercent(data.value.weightToleranceBps) : "",
);
const responseMinutes = ref(data.value?.customerResponseMinutes ?? 10);
const api = useApiClient();
const toast = useToast();
const busy = ref(false);
async function save() {
  if (busy.value) return;
  const weightToleranceBps = percentToBps(percent.value);
  if (!Number.isInteger(responseMinutes.value) || responseMinutes.value < 1 || responseMinutes.value > 120) {
    toast.add({ title: 'Укажите время ожидания от 1 до 120 минут', color: 'error' }); return;
  }
  if (weightToleranceBps === null) {
    toast.add({
      title: "Укажите от 0 до 50%, не более двух знаков после запятой",
      color: "error",
    });
    return;
  }
  busy.value = true;
  try {
    await api("/admin/settings", {
      method: "PATCH",
      body: { weightToleranceBps, customerResponseMinutes: responseMinutes.value },
    });
    await refresh();
    percent.value = bpsPercent(weightToleranceBps);
    toast.add({ title: "Настройки сохранены" });
  } catch (cause) {
    toast.add({ title: apiError(cause), color: "error" });
  } finally {
    busy.value = false;
  }
}
</script>
