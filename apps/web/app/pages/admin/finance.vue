<template>
  <section class="space-y-6">
    <header class="flex flex-wrap items-center gap-3">
      <h2 class="text-2xl font-semibold mr-auto">Финансы</h2>
      <UButton to="/admin/payouts" variant="outline">Выплаты</UButton>
      <UButton :disabled="!data" icon="i-lucide-download" @click="download">Экспорт CSV</UButton>
    </header>
    <div class="flex flex-wrap gap-2" aria-label="Период отчёта">
      <UButton v-for="option in periods" :key="option.value" :variant="period === option.value ? 'solid' : 'outline'" @click="period = option.value">{{ option.label }}</UButton>
    </div>
    <div v-if="period === 'custom'" class="flex flex-wrap items-end gap-3">
      <UFormField label="От"><UInput v-model="from" type="date" /></UFormField>
      <UFormField label="До"><UInput v-model="to" type="date" /></UFormField>
    </div>
    <UAlert v-if="error" color="error" :title="apiError(error)" />
    <p v-else-if="pending" role="status">Расчёт отчёта…</p>
    <template v-else-if="data">
      <p class="text-sm text-muted">{{ data.period.from }} — {{ data.period.to }} · {{ data.period.timezone }}</p>
      <div class="grid grid-cols-2 gap-3 md:grid-cols-4">
        <UCard v-for="metric in metrics" :key="metric.label">
          <p class="text-sm text-muted">{{ metric.label }}</p><p class="text-xl font-semibold" :class="metric.negative ? 'text-error' : ''">{{ metric.value }}</p>
        </UCard>
      </div>
      <UAlert v-if="data.legacyItemsCount || data.legacyCompletedCount" color="warning" :title="`Нет финансового снимка: ${data.legacyItemsCount} позиций; завершённых заказов без даты: ${data.legacyCompletedCount}`" />
      <UAlert v-if="data.unreconciledOrdersCount" color="warning" :title="`Итог не совпадает с суммой строк у ${data.unreconciledOrdersCount} заказов. Проверьте детализацию.`" />
      <p class="text-sm text-muted">Отменено отдельно: {{ data.cancelled.count }} · {{ money(data.cancelled.amount) }}. Доставка и услуги не входят в общую наценку.</p>
      <UCard>
        <template #header><h3 class="font-semibold">По дням</h3></template>
        <div class="overflow-x-auto"><table class="w-full min-w-[900px] text-sm text-left">
          <thead><tr><th>Дата</th><th>Заказов</th><th>Оборот</th><th>С наценкой</th><th>Без наценки</th><th>База</th><th>Наценка</th><th>{{ data.partnerNames[0] }}</th><th>{{ data.partnerNames[1] }}</th></tr></thead>
          <tbody><tr v-for="row in data.days" :key="row.date" class="border-t border-default">
            <td><UButton variant="link" :aria-expanded="selectedDay === row.date" @click="selectDay(row.date)">{{ row.date }}</UButton></td>
            <td>{{ row.ordersCount }}</td><td>{{ money(row.turnover) }}</td><td>{{ money(row.sharedRevenue) }}</td>
            <td>{{ money(row.noMarkupRevenue) }}</td><td>{{ money(row.baseAmount) }}</td>
            <td :class="row.sharedMarkup < 0 ? 'text-error' : 'text-success'">{{ money(row.sharedMarkup) }}</td>
            <td>{{ money(row.partner1Share) }}</td><td>{{ money(row.partner2Share) }}</td>
          </tr></tbody>
        </table></div>
        <p v-if="!data.days.length" class="text-muted">За период завершённых заказов нет.</p>
      </UCard>
      <UCard v-if="selectedDay">
        <template #header><h3 class="font-semibold">Расчёт за {{ selectedDay }}</h3></template>
        <p v-if="dayBusy">Загрузка…</p>
        <div v-for="order in dayOrders" :key="order.id" class="border-b border-default py-3">
          <NuxtLink :to="`/admin/orders/${order.id}`" class="text-primary font-medium">Заказ №{{ order.id }}</NuxtLink>
          <span class="text-muted"> · {{ order.customerName }} · {{ money(order.totals.turnover) }}</span>
          <p class="text-sm text-muted">Доставка {{ money(order.totals.delivery) }} · услуги {{ money(order.totals.extras) }}<span v-if="order.finalTotal !== null && order.finalTotal !== order.totals.turnover" class="text-warning"> · расхождение с итогом {{ money(order.finalTotal - order.totals.turnover) }}</span></p>
          <div v-for="line in order.lines" :key="line.id" class="flex flex-wrap justify-between gap-2 pl-3 text-sm">
            <span>{{ line.productName }} · {{ modeLabel[line.mode] }}<span v-if="line.finalPrice !== line.orderPrice" class="text-warning"> · цена {{ money(line.orderPrice) }} → {{ money(line.finalPrice) }}</span></span>
            <span>Продажа {{ money(line.saleAmount) }} · база {{ money(line.baseAmount) }} · наценка {{ money(line.sharedMarkup) }}</span>
          </div>
        </div>
      </UCard>
    </template>
  </section>
</template>
<script setup lang="ts">
import type { FinanceReport, FinanceDayOrder } from '~/types/admin-ops';
definePageMeta({ middleware: 'admin', layout: 'admin' });
const periods = [
  { label: 'Сегодня', value: 'today' }, { label: 'Вчера', value: 'yesterday' },
  { label: '7 дней', value: 'week' }, { label: 'Текущий месяц', value: 'month' },
  { label: 'Прошлый месяц', value: 'previousMonth' }, { label: 'Произвольный период', value: 'custom' },
];
const period = ref('today');
const from = ref(''); const to = ref('');
const query = computed(() => ({ period: period.value, ...(period.value === 'custom' && from.value && to.value ? { from: from.value, to: to.value } : {}) }));
const { data, pending, error } = await useApi<FinanceReport>('/admin/finance', { query });
const selectedDay = ref<string | null>(null);
const dayOrders = ref<FinanceDayOrder[]>([]);
const dayBusy = ref(false);
const api = useApiClient();
const modeLabel = { SHARED_MARKUP: '50/50', NO_MARKUP: 'Без наценки', UNSET: 'Не настроено', LEGACY: 'Нет снимка' };
const metrics = computed(() => data.value ? [
  { label: 'Оборот', value: money(data.value.turnover) },
  { label: 'Завершено заказов', value: String(data.value.ordersCount) },
  { label: 'Средний чек', value: money(data.value.averageCheck) },
  { label: 'С общей наценкой', value: money(data.value.sharedRevenue) },
  { label: 'Без наценки', value: money(data.value.noMarkupRevenue) },
  { label: 'Не настроено', value: money(data.value.unsetRevenue) },
  { label: 'Legacy', value: money(data.value.legacyRevenue) },
  { label: 'Базовая стоимость', value: money(data.value.baseAmount) },
  { label: 'Общая наценка', value: money(data.value.sharedMarkup), negative: data.value.sharedMarkup < 0 },
  { label: data.value.partnerNames[0], value: money(data.value.partner1Share) },
  { label: data.value.partnerNames[1], value: money(data.value.partner2Share) },
  { label: 'Доставка', value: money(data.value.delivery) },
  { label: 'Услуги', value: money(data.value.extras) },
] : []);
watch(query, () => { selectedDay.value = null; dayOrders.value = []; });
async function selectDay(day: string) {
  if (selectedDay.value === day) { selectedDay.value = null; return; }
  selectedDay.value = day; dayBusy.value = true;
  try {
    const rows = await api<FinanceDayOrder[]>(`/admin/finance/days/${day}`);
    if (selectedDay.value === day) dayOrders.value = rows;
  } catch (cause) {
    if (selectedDay.value === day) useToast().add({ title: apiError(cause), color: 'error' });
  } finally { if (selectedDay.value === day) dayBusy.value = false; }
}
function download() {
  if (!import.meta.client || !data.value) return;
  const base = useRuntimeConfig().public.apiBase.replace(/\/$/, '');
  const params = new URLSearchParams({ period: period.value, ...(period.value === 'custom' ? { from: from.value, to: to.value } : {}) });
  window.location.assign(`${base}/admin/finance/export.csv?${params}`);
}
</script>
