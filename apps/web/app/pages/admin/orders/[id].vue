<template>
  <section class="space-y-5">
    <AppBackButton fallback="/admin/orders" label="К заказам" />
    <UAlert v-if="error" color="error" :title="apiError(error)" />
    <template v-else-if="data">
      <header class="flex flex-wrap items-center gap-3">
        <h2 class="text-2xl font-semibold mr-auto">Заказ №{{ data.id }}</h2>
        <UBadge color="neutral">{{ data.status }}</UBadge>
        <UButton :to="`/staff/orders/${data.id}`" variant="outline">Управление заказом</UButton>
      </header>
      <div class="grid gap-4 lg:grid-cols-2">
        <UCard>
          <template #header><h3 class="font-semibold">Покупатель и получение</h3></template>
          <p>Покупатель: {{ data.purchaser?.name ?? `Аккаунт №${data.userId ?? 'гость'}` }}</p>
          <p>Получатель: {{ data.customerName }} · {{ data.customerPhone }}</p>
          <p>{{ data.type === 'PICKUP' ? 'Самовывоз' : 'Доставка' }} · {{ data.deliveryAt ? date(data.deliveryAt) : 'Как можно скорее' }}</p>
          <p v-if="data.type === 'DELIVERY'">{{ formatAddress(data) }}</p>
          <p v-if="data.comment" class="text-muted">{{ data.comment }}</p>
          <p>Создан: {{ date(data.createdAt) }} · Завершён: {{ data.completedAt ? date(data.completedAt) : '—' }}</p>
          <p>Оплата: {{ data.payment?.status ?? '—' }}</p>
          <OrderCosts v-if="data.promoCodeSnapshot" :order="data" />
          <p v-else class="font-semibold">Итог: {{ money(data.finalTotal ?? data.total ?? 0) }}</p>
        </UCard>
        <UCard>
          <template #header><h3 class="font-semibold">Товары</h3></template>
          <div v-for="item in data.items" :key="item.id" class="flex justify-between gap-3 border-b border-default py-2 text-sm">
            <span>{{ item.productName }} · {{ item.actualQty ?? item.qty }} {{ item.unit }} <UBadge v-if="item.status === 'MISSING'" color="warning">Нет в наличии</UBadge><span v-if="item.actualPrice !== null && item.actualPrice !== item.price" class="block text-warning">Цена {{ money(item.price) }} → {{ money(item.actualPrice) }}</span></span>
            <span class="whitespace-nowrap">{{ money(item.actualTotal ?? item.total) }}</span>
          </div>
        </UCard>
      </div>
      <UCard v-if="data.issues.length || data.extras.length">
        <template #header><h3 class="font-semibold">Проблемы и услуги</h3></template>
        <p v-for="issue in data.issues" :key="issue.id" class="text-sm">{{ issue.type }} · {{ issue.status }} · {{ issue.resolution ?? '—' }}</p>
        <p v-for="extra in data.extras" :key="extra.id" class="text-sm">{{ extra.title }} · {{ money(extra.amount) }} · {{ extra.status }}</p>
      </UCard>
      <UCard>
        <template #header><h3 class="font-semibold">Внутренний финансовый расчёт</h3></template>
        <div class="overflow-x-auto"><table class="w-full min-w-[620px] text-sm text-left">
          <thead><tr><th>Товар</th><th>Режим</th><th>Цена заказа → факт</th><th>Продажа</th><th>База</th><th>Наценка</th></tr></thead>
          <tbody><tr v-for="line in data.finance.lines" :key="line.id" class="border-t border-default">
            <td class="py-2">{{ line.productName }}</td>
            <td><UBadge :color="line.mode === 'LEGACY' || line.mode === 'UNSET' ? 'warning' : line.mode === 'NO_MARKUP' ? 'neutral' : 'success'">{{ modeLabel[line.mode] }}</UBadge></td>
            <td>{{ money(line.orderPrice) }}{{ line.finalPrice !== line.orderPrice ? ` → ${money(line.finalPrice)}` : '' }}</td>
            <td>{{ money(line.saleAmount) }}</td><td>{{ line.mode === 'SHARED_MARKUP' ? money(line.baseAmount) : '—' }}</td>
            <td :class="line.sharedMarkup < 0 ? 'text-error' : 'text-success'">{{ money(line.sharedMarkup) }}</td>
          </tr></tbody>
        </table></div>
        <div class="grid gap-2 mt-4 sm:grid-cols-3">
          <p>Общая наценка: <strong>{{ money(data.finance.totals.sharedMarkup) }}</strong></p>
          <p>Партнёр 1: <strong>{{ money(data.finance.totals.partner1Share) }}</strong></p>
          <p>Партнёр 2: <strong>{{ money(data.finance.totals.partner2Share) }}</strong></p>
        </div>
        <UAlert v-if="data.finance.totals.legacyItemsCount" color="warning" title="Есть позиции без финансового снимка" />
      </UCard>
      <div class="grid gap-4 lg:grid-cols-2">
        <UCard><template #header><h3 class="font-semibold">История</h3></template>
          <p v-for="event in data.history" :key="event.id" class="py-1 text-sm">{{ date(event.createdAt) }} · {{ event.action }}</p>
        </UCard>
        <UCard><template #header><h3 class="font-semibold">Сообщения</h3></template>
          <p v-for="entry in data.messages" :key="entry.id" class="py-1 text-sm">{{ date(entry.createdAt) }} · {{ entry.text }}</p>
        </UCard>
      </div>
      <UCard v-if="data.priceChanges.length">
        <template #header><h3 class="font-semibold">Изменения цен позиций</h3></template>
        <p v-for="change in data.priceChanges" :key="change.id" class="border-b border-default py-2 text-sm">
          {{ date(change.createdAt) }} · {{ change.item.productName }} · {{ money(change.previousPrice) }} → {{ money(change.newPrice) }} · {{ change.actor.name || change.actor.role }}<span v-if="change.reason"> · {{ change.reason }}</span>
        </p>
      </UCard>
    </template>
  </section>
</template>
<script setup lang="ts">
import { formatAddress } from "~/utils/address";
import type { AdminOrderDetail } from '~/types/admin-ops';
definePageMeta({ middleware: 'admin', layout: 'admin' });
const route = useRoute();
const { data, error } = await useApi<AdminOrderDetail>(`/admin/orders/${route.params.id}`);
const date = (value: string) => new Date(value).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
const modeLabel = { SHARED_MARKUP: '50/50', NO_MARKUP: 'Без наценки', UNSET: 'Не настроено', LEGACY: 'Нет финансового снимка' };
</script>
