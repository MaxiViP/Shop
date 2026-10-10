<template>
  <section class="space-y-6">
    <h2 class="text-2xl font-semibold">Настройки</h2>
    <UCard>
      <h3 class="font-semibold">Очередь и нагрузка</h3>
      <p class="text-muted mt-2">Обычный и пиковый режимы, сборщики, время сборки и запись заказов ко времени.</p>
      <UButton to="/admin/queue" class="mt-3" icon="i-lucide-gauge">Открыть раздел</UButton>
    </UCard>
    <UAlert v-if="error" color="error" title="Не удалось загрузить настройки" />
    <p v-if="pending">Загрузка…</p>
    <UCard v-else-if="data">
      <template #header
        ><h3 class="font-semibold">Бизнес-настройки</h3></template
      >
      <form class="space-y-4 max-w-xl" @submit.prevent="save">
        <h3 class="font-semibold">Заказы</h3>
        <UFormField
          v-for="field in moneyFields"
          :key="field.key"
          :label="field.label"
          required
        >
          <UInput
            v-model="amounts[field.key]"
            inputmode="decimal"
            :disabled="busy"
            required
          />
        </UFormField>
        <p class="text-muted">
          Суммы до 1 000 000 ₽. Минимум доставки может быть нулевым; лимиты
          услуг — положительные.
        </p>
        <h3 class="font-semibold">Получение заказа</h3>
        <USwitch v-model="deliveryEnabled" label="Доставка" :disabled="busy" />
        <USwitch v-model="pickupEnabled" label="Самовывоз" :disabled="busy" />
        <USwitch v-model="freeDeliveryEnabled" label="Бесплатная доставка от суммы" :disabled="busy" />
        <UFormField label="Порог бесплатной доставки, ₽" :required="freeDeliveryEnabled">
          <UInput v-model="freeDeliveryRubles" inputmode="decimal" :disabled="busy" :required="freeDeliveryEnabled" />
        </UFormField>
        <p class="text-muted">Положительная сумма до 1 000 000 ₽. Учитывается стоимость товаров с сервисом KorzinaMarket; доставка и дополнительные услуги не входят в порог. Условие фиксируется при оформлении заказа.</p>
        <p role="status">{{ data.freeDeliveryEnabled && data.deliveryEnabled ? `Включено от ${money(data.freeDeliveryThreshold ?? 0)}` : 'Бесплатная доставка отключена' }}</p>
        <p v-if="!deliveryEnabled && !pickupEnabled" class="text-error">
          Должен быть доступен хотя бы один способ получения заказа.
        </p>
        <h3 class="font-semibold">Сборка заказов</h3>
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
          <UInput
            v-model.number="responseMinutes"
            type="number"
            min="1"
            max="120"
            step="1"
            :disabled="busy"
          />
        </UFormField>
        <p class="text-muted">
          От 1 до 120 минут. После этого продавцу предлагается позвонить
          покупателю. Автоматических повторных SMS нет.
        </p>
        <h3 class="font-semibold">Партнёры · 50/50</h3>
        <UFormField label="Партнёр 1"><UInput v-model="partner1Name" maxlength="80" class="w-full" /></UFormField>
        <UFormField label="Партнёр 2"><UInput v-model="partner2Name" maxlength="80" class="w-full" /></UFormField>
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
  minDeliverySubtotal: number;
  maxOrderExtraUnitPrice: number;
  maxOrderExtrasTotal: number;
  deliveryEnabled: boolean;
  pickupEnabled: boolean;
  freeDeliveryEnabled: boolean;
  freeDeliveryThreshold: number | null;
  partner1Name: string;
  partner2Name: string;
}>("/admin/settings");
const moneyFields = [
  {
    key: "minDeliverySubtotal",
    label: "Минимальная сумма заказа для доставки, ₽",
  },
  {
    key: "maxOrderExtraUnitPrice",
    label: "Максимальная цена единицы дополнительной услуги, ₽",
  },
  {
    key: "maxOrderExtrasTotal",
    label: "Максимальная сумма дополнительных услуг, ₽",
  },
] as const;
const amounts = reactive({
  minDeliverySubtotal: kopecksToRubles(
    data.value?.minDeliverySubtotal ?? 300000,
  ),
  maxOrderExtraUnitPrice: kopecksToRubles(
    data.value?.maxOrderExtraUnitPrice ?? 500000,
  ),
  maxOrderExtrasTotal: kopecksToRubles(
    data.value?.maxOrderExtrasTotal ?? 1000000,
  ),
});
const deliveryEnabled = ref(data.value?.deliveryEnabled ?? true);
const pickupEnabled = ref(data.value?.pickupEnabled ?? true);
const freeDeliveryEnabled = ref(data.value?.freeDeliveryEnabled ?? false);
const freeDeliveryRubles = ref(data.value?.freeDeliveryThreshold ? kopecksToRubles(data.value.freeDeliveryThreshold) : '');
const partner1Name = ref(data.value?.partner1Name ?? "Партнёр 1");
const partner2Name = ref(data.value?.partner2Name ?? "Партнёр 2");
const percent = ref(
  data.value ? bpsPercent(data.value.weightToleranceBps) : "",
);
const responseMinutes = ref(data.value?.customerResponseMinutes ?? 10);
const api = useApiClient();
const toast = useToast();
const busy = ref(false);
async function save() {
  if (busy.value) return;
  const freeDeliveryThreshold = freeDeliveryRubles.value.trim() ? rublesToKopecks(freeDeliveryRubles.value) : null;
  if ((freeDeliveryEnabled.value || freeDeliveryRubles.value.trim()) && freeDeliveryThreshold === null) {
    toast.add({ title: 'Укажите положительный порог бесплатной доставки до 1 000 000 ₽', color: 'error' });
    return;
  }
  const minDeliverySubtotal = rublesToKopecks(
    amounts.minDeliverySubtotal,
    true,
  );
  const maxOrderExtraUnitPrice = rublesToKopecks(
    amounts.maxOrderExtraUnitPrice,
  );
  const maxOrderExtrasTotal = rublesToKopecks(amounts.maxOrderExtrasTotal);
  if (
    minDeliverySubtotal === null ||
    maxOrderExtraUnitPrice === null ||
    maxOrderExtrasTotal === null ||
    maxOrderExtrasTotal < maxOrderExtraUnitPrice
  ) {
    toast.add({
      title:
        "Проверьте суммы: общий лимит услуг не может быть меньше цены одной услуги",
      color: "error",
    });
    return;
  }
  if (!deliveryEnabled.value && !pickupEnabled.value) {
    toast.add({
      title: "Должен быть доступен хотя бы один способ получения заказа.",
      color: "error",
    });
    return;
  }
  const weightToleranceBps = percentToBps(percent.value);
  if (
    !Number.isInteger(responseMinutes.value) ||
    responseMinutes.value < 1 ||
    responseMinutes.value > 120
  ) {
    toast.add({
      title: "Укажите время ожидания от 1 до 120 минут",
      color: "error",
    });
    return;
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
      body: {
        weightToleranceBps,
        customerResponseMinutes: responseMinutes.value,
        minDeliverySubtotal,
        maxOrderExtraUnitPrice,
        maxOrderExtrasTotal,
        deliveryEnabled: deliveryEnabled.value,
        pickupEnabled: pickupEnabled.value,
        freeDeliveryEnabled: freeDeliveryEnabled.value,
        freeDeliveryThreshold,
        partner1Name: partner1Name.value.trim(),
        partner2Name: partner2Name.value.trim(),
      },
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
