<template>
  <section class="space-y-6">
    <header><h2 class="text-2xl font-semibold">Обзор магазина</h2><p class="text-muted">Сегодня · Europe/Moscow</p></header>
    <UAlert v-if="error" color="error" :title="apiError(error)" />
    <template v-else-if="data">
      <div class="grid grid-cols-2 gap-3 md:grid-cols-4">
        <UCard v-for="metric in metrics" :key="metric.label">
          <p class="text-sm text-muted">{{ metric.label }}</p>
          <p class="text-xl font-semibold">{{ metric.value }}</p>
        </UCard>
      </div>
      <div class="grid gap-4 lg:grid-cols-2">
        <UCard>
          <template #header><h3 class="font-semibold">Очередь и время подготовки</h3></template>
          <p>Сейчас ожидают: <strong>{{ data.queue.queueLength }}</strong> · оценка сборки: {{ data.queue.estimatedAssemblyMinutes }} мин. · в расчёте {{ data.queue.assemblyConcurrency }} сборщ.</p>
          <p>Заказов ко времени: <strong>{{ data.queue.scheduledOrders }}</strong></p>
          <p>Режим высокой нагрузки: {{ data.queue.peakModeActive ? 'активен' : 'не активен' }}</p>
          <div v-if="data.queue.slots.length" class="mt-2 text-sm text-muted">
            Ближайшие слоты:
            <span v-for="slot in data.queue.slots.slice(0, 4)" :key="slot.at" class="block">{{ dayTime(slot.at) }} · {{ slot.reserved }}/{{ slot.capacity }} занято</span>
          </div>
          <UButton to="/admin/settings" variant="link">Настроить нагрузку</UButton>
        </UCard>
        <UCard>
          <template #header><h3 class="font-semibold">Рынок</h3></template>
          <UBadge :color="data.market.isOpen ? 'success' : 'neutral'">{{ data.market.isOpen ? 'Сейчас открыт' : 'Сейчас закрыт' }}</UBadge>
          <p class="mt-2">Сегодня: {{ data.market.openTime && data.market.closeTime ? `${data.market.openTime}–${data.market.closeTime}` : 'выходной' }}</p>
          <p v-if="data.upcomingException" class="text-sm text-muted mt-2">Ближайший особый день: {{ day(data.upcomingException.date) }}</p>
          <UButton to="/admin/schedule" variant="link">Изменить график</UButton>
        </UCard>
        <UCard>
          <template #header><h3 class="font-semibold">Заказы в работе</h3></template>
          <div class="grid grid-cols-2 gap-2">
            <p v-for="state in states" :key="state.status">{{ state.label }}: <strong>{{ count(state.status) }}</strong></p>
          </div>
          <UButton to="/admin/orders" variant="link">Все заказы</UButton>
        </UCard>
      </div>
      <div class="grid gap-4 lg:grid-cols-2">
        <UCard>
          <template #header><h3 class="font-semibold">Продажи за 7 дней</h3></template>
          <div v-for="row in data.week" :key="row.date" class="flex items-center gap-3 py-1 text-sm">
            <span class="w-20 shrink-0">{{ day(row.date) }}</span>
            <div class="h-3 rounded bg-primary/20 min-w-1" :style="{ width: `${Math.max(2, row.turnover / maxWeek * 100)}%` }" />
            <span class="whitespace-nowrap">{{ money(row.turnover) }}</span>
          </div>
          <UButton to="/admin/finance" variant="link">Финансовый отчёт</UButton>
        </UCard>
        <UCard>
          <template #header><h3 class="font-semibold">Последние заказы</h3></template>
          <div v-for="order in data.latest" :key="order.id" class="flex justify-between gap-3 border-b border-default py-2 text-sm">
            <NuxtLink :to="`/admin/orders/${order.id}`" class="text-primary">№{{ order.id }} · {{ order.customerName }}</NuxtLink>
            <span class="whitespace-nowrap">{{ money(order.finalTotal ?? order.total ?? 0) }}</span>
          </div>
        </UCard>
      </div>
    </template>
  </section>
</template>
<script setup lang="ts">
import type { FinanceReport, FinanceDay, ShopStatus, ShopHoursException, AdminOrderRow } from '~/types/admin-ops';
import type { QueueOffer } from '~/types/order';
definePageMeta({ middleware: 'admin', layout: 'admin' });
const { data, error } = await useApi<{
  today: FinanceReport; ordersToday: number; week: FinanceDay[]; market: ShopStatus;
  statuses: { status: string; _count: { id: number } }[];
  latest: AdminOrderRow[]; upcomingException: ShopHoursException | null;
  queue: QueueOffer & { scheduledOrders: number };
}>('/admin/dashboard');
const day = (value: string) => new Date(value).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit' });
const dayTime = (value: string) => new Date(value).toLocaleString('ru-RU', {
  timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
});
const states = [
  { status: 'NEW', label: 'Новые' }, { status: 'ASSEMBLING', label: 'Собираются' },
  { status: 'READY', label: 'Готовы' }, { status: 'DELIVERING', label: 'Доставляются' },
];
const count = (status: string) => data.value?.statuses.find(row => row.status === status)?._count.id ?? 0;
const maxWeek = computed(() => Math.max(1, ...(data.value?.week.map(row => row.turnover) ?? [])));
const metrics = computed(() => {
  const today = data.value?.today;
  return today ? [
    { label: 'Заказов сегодня', value: String(data.value?.ordersToday ?? 0) },
    { label: 'Завершено', value: String(today.ordersCount) },
    { label: 'Оборот', value: money(today.turnover) },
    { label: 'Средний чек', value: money(today.averageCheck) },
    { label: 'Общая наценка', value: money(today.sharedMarkup) },
    { label: today.partnerNames[0], value: money(today.partner1Share) },
    { label: today.partnerNames[1], value: money(today.partner2Share) },
  ] : [];
});
</script>
