<template>
  <UContainer class="py-6 space-y-5">
    <div class="flex flex-wrap gap-3 items-center">
      <h1 class="text-2xl font-semibold mr-auto">Товары и категории моей точки</h1>
      <UButton to="/staff/orders" variant="soft">Заказы</UButton>
      <UButton to="/staff/products/new" icon="i-lucide-plus">Добавить товар</UButton>
    </div>
    <p class="text-muted">Редактируйте свои фотографии, описание, цену продавца, условия продажи и наличие. Наценку сервиса и отметки настраивает администратор.</p>
    <form class="flex flex-wrap gap-3 items-end" @submit.prevent="apply">
      <UFormField label="Поиск"><UInput v-model="search" placeholder="Название товара" maxlength="160" /></UFormField>
      <UFormField label="Моя точка"><USelect v-model="point" :items="pointOptions" /></UFormField>
      <UFormField label="Категория"><USelect v-model="category" :items="categoryOptions" /></UFormField>
      <UFormField label="Наличие"><USelect v-model="active" :items="[{ label: 'Все', value: 'all' }, { label: 'Опубликованы', value: 'true' }, { label: 'Скрыты', value: 'false' }]" /></UFormField>
      <UButton type="submit" :loading="pending">Найти</UButton>
    </form>
    <p v-if="pending" role="status">Загрузка…</p>
    <UAlert v-else-if="error" color="error" :title="apiError(error)" />
    <p v-else-if="!data?.items.length">По этим условиям своих товаров пока нет.</p>
    <div v-else class="space-y-3">
      <article v-for="product in data.items" :key="product.id" class="flex flex-wrap items-center gap-3 border border-default rounded-lg p-3">
        <img v-if="product.images[0]" :src="asset(product.images[0].url)" :alt="product.name" class="w-16 h-16 object-cover rounded" >
        <div class="flex-1 min-w-40">
          <NuxtLink :to="`/staff/products/${product.id}`" class="font-semibold text-primary">{{ product.name }}</NuxtLink>
          <p class="text-sm text-muted">{{ product.category.name }} · {{ product.marketPoint?.name }}</p>
          <p>{{ money(product.price) }} / {{ product.priceQty }} {{ unitLabels[product.unit] }}</p>
        </div>
        <UBadge :color="product.active ? 'success' : 'neutral'">{{ product.active ? 'Опубликован' : 'Скрыт' }}</UBadge>
        <UButton :to="`/staff/products/${product.id}`" variant="outline">Редактировать</UButton>
      </article>
    </div>
    <div v-if="data" class="flex items-center gap-3">
      <UButton :disabled="pending || query.page <= 1" variant="soft" @click="query.page--">Назад</UButton>
      <span>{{ query.page }} / {{ Math.max(1, data.pages) }} · {{ data.total }} товаров</span>
      <UButton :disabled="pending || query.page >= data.pages" variant="soft" @click="query.page++">Далее</UButton>
    </div>
  </UContainer>
</template>

<script setup lang="ts">
import type { AdminCategory, AdminProduct, AdminPage } from '~/types/admin';
import type { MarketPoint } from '~/types/market-map';
definePageMeta({ middleware: 'owner' });
const search = ref(''), point = ref(0), category = ref(0), active = ref('all');
const query = reactive({ page: 1, limit: 20, search: '', marketPoint: undefined as number | undefined,
  category: undefined as number | undefined, active: undefined as string | undefined });
const { data, pending, error } = await useApi<AdminPage<AdminProduct>>('/owner/products', { query });
const { data: points } = await useApi<MarketPoint[]>('/owner/points');
const { data: categories } = await useApi<AdminCategory[]>('/owner/categories');
const pointOptions = computed(() => [{ label: 'Все мои точки', value: 0 }, ...(points.value ?? []).map(item => ({ label: item.name, value: item.id }))]);
const categoryOptions = computed(() => [{ label: 'Все категории', value: 0 }, ...(categories.value ?? []).map(item => ({ label: item.name, value: item.id }))]);
const unitLabels = { GRAM: 'г', PIECE: 'шт.', BUNCH: 'пуч.', PACK: 'уп.' };
const asset = useAsset();
function apply() { Object.assign(query, { page: 1, search: search.value, marketPoint: point.value || undefined,
  category: category.value || undefined, active: active.value === 'all' ? undefined : active.value }); }
</script>
