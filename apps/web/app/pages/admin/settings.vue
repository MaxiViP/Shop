<template>
  <section class="space-y-6">
    <h2 class="text-2xl font-semibold">Настройки</h2>
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
        <h3 class="font-semibold">Очередь и заказ ко времени</h3>
        <UFormField label="Порог очереди для предложения времени" required>
          <UInput v-model.number="queueThreshold" type="number" min="1" max="100" :disabled="busy" />
        </UFormField>
        <UFormField label="Оценка сборки без истории, мин." required>
          <UInput v-model.number="assemblyFallbackMinutes" type="number" min="5" max="180" :disabled="busy" />
        </UFormField>
        <UFormField label="Сборщиков для расчёта ожидания" required>
          <UInput v-model.number="assemblyConcurrency" type="number" min="1" max="30" :disabled="busy" />
        </UFormField>
        <p class="text-muted">Плановая параллельная сборка; число сотрудников онлайн не определяется автоматически.</p>
        <UFormField label="Шаг слотов, мин." required>
          <select v-model.number="slotIntervalMinutes" class="settings__select" :disabled="busy">
            <option :value="15">15</option><option :value="30">30</option><option :value="60">60</option>
          </select>
        </UFormField>
        <UFormField label="Заказов на один слот" required>
          <UInput v-model.number="slotCapacity" type="number" min="1" max="30" :disabled="busy" />
        </UFormField>
        <USwitch v-model="peakModeEnabled" label="Режим высокой нагрузки" :disabled="busy" />
        <p class="text-muted">После окончания периода предложение времени отключится автоматически, если очередь ниже порога.</p>
        <div v-if="peakModeEnabled" class="settings__period">
          <UFormField label="Начало (Москва)" required><UInput v-model="peakModeStart" type="datetime-local" :disabled="busy" /></UFormField>
          <UFormField label="Окончание (Москва)" required><UInput v-model="peakModeEnd" type="datetime-local" :disabled="busy" /></UFormField>
        </div>
        <h3 class="font-semibold">Партнёры · 50/50</h3>
        <UFormField label="Партнёр 1"><UInput v-model="partner1Name" maxlength="80" class="w-full" /></UFormField>
        <UFormField label="Партнёр 2"><UInput v-model="partner2Name" maxlength="80" class="w-full" /></UFormField>
        <UButton type="submit" :loading="busy">Сохранить</UButton>
      </form>
    </UCard>
  </section>
</template>

<script setup lang="ts">
import { pickupDate } from '~/utils/pickup';
definePageMeta({ layout: "admin", middleware: "admin" });
const { data, pending, error, refresh } = await useApi<{
  weightToleranceBps: number;
  customerResponseMinutes: number;
  minDeliverySubtotal: number;
  maxOrderExtraUnitPrice: number;
  maxOrderExtrasTotal: number;
  deliveryEnabled: boolean;
  pickupEnabled: boolean;
  partner1Name: string;
  partner2Name: string;
  queueThreshold: number;
  assemblyFallbackMinutes: number;
  assemblyConcurrency: number;
  peakModeEnabled: boolean;
  peakModeStart: string | null;
  peakModeEnd: string | null;
  slotIntervalMinutes: number;
  slotCapacity: number;
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
const partner1Name = ref(data.value?.partner1Name ?? "Партнёр 1");
const partner2Name = ref(data.value?.partner2Name ?? "Партнёр 2");
const percent = ref(
  data.value ? bpsPercent(data.value.weightToleranceBps) : "",
);
const responseMinutes = ref(data.value?.customerResponseMinutes ?? 10);
const queueThreshold = ref(data.value?.queueThreshold ?? 4);
const assemblyFallbackMinutes = ref(data.value?.assemblyFallbackMinutes ?? 25);
const assemblyConcurrency = ref(data.value?.assemblyConcurrency ?? 1);
const slotIntervalMinutes = ref(data.value?.slotIntervalMinutes ?? 30);
const slotCapacity = ref(data.value?.slotCapacity ?? 1);
const peakModeEnabled = ref(data.value?.peakModeEnabled ?? false);
const moscowInput = (value: string | null | undefined) => value
  ? new Date(Date.parse(value) + 3 * 60 * 60 * 1000).toISOString().slice(0, 16) : '';
const peakModeStart = ref(moscowInput(data.value?.peakModeStart));
const peakModeEnd = ref(moscowInput(data.value?.peakModeEnd));
const api = useApiClient();
const toast = useToast();
const busy = ref(false);
async function save() {
  if (busy.value) return;
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
  const start = pickupDate(peakModeStart.value);
  const end = pickupDate(peakModeEnd.value);
  if (peakModeEnabled.value && (!start || !end || end <= start)) {
    toast.add({ title: 'Укажите начало и окончание периода высокой нагрузки', color: 'error' });
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
        partner1Name: partner1Name.value.trim(),
        partner2Name: partner2Name.value.trim(),
        queueThreshold: queueThreshold.value,
        assemblyFallbackMinutes: assemblyFallbackMinutes.value,
        assemblyConcurrency: assemblyConcurrency.value,
        slotIntervalMinutes: slotIntervalMinutes.value,
        slotCapacity: slotCapacity.value,
        peakModeEnabled: peakModeEnabled.value,
        peakModeStart: start?.toISOString() ?? null,
        peakModeEnd: end?.toISOString() ?? null,
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

<style scoped>
.settings__period { display: grid; gap: 0.75rem; grid-template-columns: repeat(auto-fit, minmax(min(100%, 14rem), 1fr)); }
.settings__select { width: 100%; min-height: var(--touch-target); padding: 0.5rem; border: 1px solid var(--ui-border); border-radius: 0.5rem; background: var(--ui-bg); }
</style>
