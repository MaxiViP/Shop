<template>
  <section class="space-y-5">
    <header class="flex flex-wrap items-center justify-between gap-3">
      <h2 class="text-2xl font-semibold">Все заказы</h2>
      <span v-if="data" class="text-muted">Всего: {{ data.total }}</span>
    </header>
    <form class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" @submit.prevent="apply">
      <UFormField label="Поиск"><UInput v-model="filters.search" placeholder="Имя, телефон или №" /></UFormField>
      <UFormField label="№ заказа"><UInput v-model="filters.number" inputmode="numeric" /></UFormField>
      <UFormField label="Телефон"><UInput v-model="filters.phone" inputmode="tel" /></UFormField>
      <UFormField label="Имя клиента"><UInput v-model="filters.name" /></UFormField>
      <UFormField label="Дата от"><UInput v-model="filters.from" type="date" /></UFormField>
      <UFormField label="Дата до"><UInput v-model="filters.to" type="date" /></UFormField>
      <UFormField label="Статус"><USelect v-model="filters.status" :items="statuses" /></UFormField>
      <UFormField label="Тип"><USelect v-model="filters.type" :items="types" /></UFormField>
      <UFormField label="Оплата"><USelect v-model="filters.paymentStatus" :items="payments" /></UFormField>
      <div class="flex flex-wrap items-end gap-2 sm:col-span-2 lg:col-span-3">
        <UButton type="button" variant="outline" @click="quickDay(0)">Сегодня</UButton>
        <UButton type="button" variant="outline" @click="quickDay(-1)">Вчера</UButton>
        <UButton type="submit">Применить</UButton>
      </div>
    </form>
    <UAlert v-if="error" color="error" :title="apiError(error)" />
    <p v-else-if="pending" role="status">Загрузка…</p>
    <p v-else-if="!data?.items.length">Заказы не найдены.</p>
    <template v-else>
      <div class="grid gap-3 md:hidden">
        <NuxtLink v-for="order in data.items" :key="order.id" :to="`/admin/orders/${order.id}`" class="block rounded-xl border border-default p-4">
          <div class="flex justify-between gap-3"><strong>№{{ order.id }}</strong><UBadge color="neutral">{{ order.status }}</UBadge></div>
          <p>{{ order.customerName }} · {{ order.customerPhone }}</p>
          <p class="text-sm text-muted">{{ formatDate(order.createdAt) }} · {{ order.type === 'PICKUP' ? 'Самовывоз' : 'Доставка' }}</p>
          <p class="text-sm text-muted">Получение: {{ order.deliveryAt ? formatDate(order.deliveryAt) : 'Как можно скорее' }}</p>
          <p class="text-sm text-muted">Оплата: {{ order.payment?.status ?? '—' }}</p>
          <p class="font-semibold">{{ money(order.finalTotal ?? order.total ?? 0) }}</p>
        </NuxtLink>
      </div>
      <div class="hidden md:block overflow-x-auto rounded-xl border border-default">
        <table class="w-full min-w-[960px] text-sm text-left">
          <thead class="bg-elevated"><tr><th class="p-3">№</th><th>Дата</th><th>Клиент</th><th>Телефон</th><th>Тип</th><th>Получение</th><th>Сумма</th><th>Оплата</th><th>Статус</th></tr></thead>
          <tbody><tr v-for="order in data.items" :key="order.id" class="border-t border-default">
            <td class="p-3"><NuxtLink class="text-primary" :to="`/admin/orders/${order.id}`">{{ order.id }}</NuxtLink></td>
            <td>{{ formatDate(order.createdAt) }}</td><td>{{ order.customerName }}</td><td>{{ order.customerPhone }}</td>
            <td>{{ order.type === 'PICKUP' ? 'Самовывоз' : 'Доставка' }}</td>
            <td>{{ order.deliveryAt ? formatDate(order.deliveryAt) : 'Как можно скорее' }}</td>
            <td class="whitespace-nowrap">{{ money(order.finalTotal ?? order.total ?? 0) }}</td>
            <td>{{ order.payment?.status ?? '—' }}</td><td>{{ order.status }}</td>
          </tr></tbody>
        </table>
      </div>
      <nav class="flex items-center gap-3" aria-label="Страницы заказов">
        <UButton variant="outline" :disabled="page <= 1" @click="move(-1)">Назад</UButton>
        <span>{{ page }} / {{ Math.max(1, data.pages) }}</span>
        <UButton variant="outline" :disabled="page >= data.pages" @click="move(1)">Далее</UButton>
      </nav>
    </template>
  </section>
</template>
<script setup lang="ts">
import type { AdminPage } from '~/types/admin';
import type { AdminOrderRow } from '~/types/admin-ops';
definePageMeta({ middleware: 'admin', layout: 'admin' });
const route = useRoute();
const value = (key: string) => typeof route.query[key] === 'string' ? String(route.query[key]) : '';
const filters = reactive({ search: value('search'), number: value('number'), phone: value('phone'),
  name: value('name'), from: value('from'), to: value('to'), status: value('status') || 'all',
  type: value('type') || 'all', paymentStatus: value('paymentStatus') || 'all' });
const statuses = [{ label: 'Все', value: 'all' }, ...['NEW', 'CONFIRMED', 'ASSEMBLING', 'READY', 'DELIVERING', 'COMPLETED', 'CANCELED'].map(value => ({ label: value, value }))];
const types = [{ label: 'Все', value: 'all' }, { label: 'Доставка', value: 'DELIVERY' }, { label: 'Самовывоз', value: 'PICKUP' }];
const payments = [{ label: 'Все', value: 'all' }, ...['AWAITING', 'REPORTED', 'PAID', 'CANCELED'].map(value => ({ label: value, value }))];
const page = computed(() => Math.max(1, Number(value('page')) || 1));
const query = computed(() => Object.fromEntries(Object.entries(route.query).filter(([, item]) => typeof item === 'string' && item)));
const { data, pending, error } = await useApi<AdminPage<AdminOrderRow>>('/admin/orders', { query });
const formatDate = (value: string) => new Date(value).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
function apply() {
  const next = Object.fromEntries(Object.entries(filters).filter(([, item]) => item && item !== 'all'));
  void navigateTo({ path: '/admin/orders', query: { ...next, page: '1' } });
}
function move(delta: number) { void navigateTo({ path: '/admin/orders', query: { ...route.query, page: String(page.value + delta) } }); }
function quickDay(offset: number) {
  const date = new Date(); date.setUTCDate(date.getUTCDate() + offset);
  const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  filters.from = day; filters.to = day; apply();
}
</script>
