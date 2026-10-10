<template>
  <section class="hits">
    <h2 class="text-2xl font-semibold">Хиты рынка</h2>
    <p class="text-muted">Рейтинг обновляется ежедневно по Москве. Учитываются только оплаченные завершённые заказы и фактически собранные товары. Возвращённая доставка и заказы без подтверждённой оплаты исключаются.</p>
    <UAlert v-if="error" color="error" :title="apiError(error)" :actions="[{ label: 'Повторить', onClick: () => refresh() }]" />
    <form v-if="data" class="hits__settings" @submit.prevent="save">
      <UFormField label="Период, дней"><UInput v-model.number="periodDays" type="number" min="1" max="365" required :disabled="busy" /></UFormField>
      <UFormField label="Минимум завершённых заказов"><UInput v-model.number="minOrders" type="number" min="1" max="1000000" required :disabled="busy" /></UFormField>
      <UFormField label="Лидеры категории, %"><UInput v-model="share" inputmode="decimal" required :disabled="busy" /></UFormField>
      <UButton type="submit" :loading="busy">Сохранить и пересчитать</UButton>
    </form>
    <div class="hits__actions">
      <p v-if="data" role="status">Последний пересчёт: {{ data.settings.lastCalculatedAt ? pickupTime(data.settings.lastCalculatedAt) : 'Ещё не выполнялся' }}</p>
      <UButton variant="outline" :loading="busy" @click="recalculate">Пересчитать сейчас</UButton>
    </div>
    <p class="text-sm text-muted">Сначала — число уникальных завершённых заказов, затем — проданное количество; при равенстве — ID товара. Доля берётся от опубликованных товаров категории, округляется вверх. Минимум заказов обязателен для каждого хита.</p>
    <div class="hits__actions" role="group" aria-label="Источник отметки ХИТ">
      <UButton v-for="tab in tabs" :key="tab.value" :variant="(query.hitMode ?? 'ALL') === tab.value ? 'solid' : 'outline'" @click="showMode(tab.value)">{{ tab.label }}</UButton>
    </div>
    <p class="text-sm text-muted">Ручная отметка меняет только показ «ХИТ». Заказы, проданное количество, место и автоматический результат остаются показателями реальных продаж.</p>
    <form class="hits__filters" @submit.prevent="apply">
      <UFormField label="Категория"><USelect v-model="category" :items="categoryItems" class="w-full" /></UFormField>
      <UFormField label="Товар"><UInput v-model="search" maxlength="160" class="w-full" /></UFormField>
      <UButton type="submit" variant="outline">Найти</UButton>
    </form>
    <p v-if="pending">Загрузка…</p>
    <template v-else-if="data">
      <p v-if="!data.settings.lastCalculatedAt">Первый пересчёт статистики ещё не выполнялся. Ручные отметки доступны независимо от него.</p>
      <p v-if="!data.items.length">Товары не найдены.</p>
      <div v-else class="hits__table">
        <table>
          <thead><tr><th>Товар</th><th>Категория</th><th>Место</th><th>Заказы</th><th>Продано</th><th>Автоматический ХИТ</th><th>Режим</th><th>Итоговый ХИТ</th></tr></thead>
          <tbody>
            <tr v-for="product in data.items" :key="product.id">
              <td><NuxtLink :to="`/admin/products/${product.id}`" class="text-primary">{{ product.name }}</NuxtLink></td>
              <td>{{ product.category.name }}</td><td>{{ product.hitRank ?? '—' }}</td><td>{{ product.hitOrders }}</td>
              <td>{{ Number(product.hitSoldUnits).toLocaleString('ru-RU', { maximumFractionDigits: 3 }) }} {{ units[product.unit] }}</td>
              <td>{{ product.autoHit ? 'Да' : 'Нет' }}</td>
              <td><USelect :model-value="product.hitMode" :items="hitModes" :disabled="busy" :aria-label="`Режим ХИТ: ${product.name}`" @update:model-value="setMode(product, $event)" /></td>
              <td><UBadge v-if="product.isHit" color="warning">ХИТ</UBadge><span v-else>—</span></td>
            </tr>
          </tbody>
        </table>
      </div>
      <UPagination v-if="data.total > query.limit" v-model:page="query.page" :total="data.total" :items-per-page="query.limit" :sibling-count="0" />
    </template>
  </section>
</template>

<script setup lang="ts">
import type { AdminCategory, AdminPage } from '~/types/admin';
import type { HitMode, HitProduct, HitSettings } from '~/types/badges';
import { hitModes } from '~/utils/badges';
import { pickupTime } from '~/utils/pickup';
definePageMeta({ middleware: 'admin', layout: 'admin' });
const query = reactive({ page: 1, limit: 20, category: undefined as number | undefined, search: '', hitMode: undefined as HitMode | undefined });
const tabs: { label: string; value: HitMode | 'ALL' }[] = [
  { label: 'Все товары', value: 'ALL' }, { label: 'Автоматические', value: 'AUTO' },
  { label: 'Отмеченные вручную', value: 'MANUAL' }, { label: 'Выключенные', value: 'OFF' },
];
function showMode(mode: HitMode | 'ALL') { query.page = 1; query.hitMode = mode === 'ALL' ? undefined : mode; }
const { data, pending, error, refresh } = await useApi<AdminPage<HitProduct> & { settings: HitSettings }>('/admin/hits', { query });
const { data: categories } = await useApi<AdminCategory[]>('/admin/categories');
const category = ref(0);
const search = ref('');
const categoryItems = computed(() => [{ label: 'Все категории', value: 0 }, ...(categories.value ?? []).map(item => ({ label: item.name, value: item.id }))]);
const periodDays = ref(data.value?.settings.periodDays ?? 30);
const minOrders = ref(data.value?.settings.minOrders ?? 3);
const share = ref(kopecksToRubles(data.value?.settings.shareBps ?? 1500));
if (!data.value) watch(() => data.value?.settings, value => {
  if (!value) return;
  periodDays.value = value.periodDays;
  minOrders.value = value.minOrders;
  share.value = kopecksToRubles(value.shareBps);
}, { once: true });
const units = { GRAM: 'кг', PIECE: 'шт.', BUNCH: 'пуч.', PACK: 'уп.' };
const api = useApiClient();
const toast = useToast();
const busy = ref(false);
async function setMode(product: HitProduct, hitMode: HitMode) {
  if (busy.value) return;
  busy.value = true;
  try { await api('/admin/hits/assign', { method: 'POST', body: { ids: [product.id], hitMode } }); await refresh(); }
  catch (value) { toast.add({ title: apiError(value), color: 'error' }); }
  finally { busy.value = false; }
}
function apply() { Object.assign(query, { page: 1, category: category.value || undefined, search: search.value }); }
async function run(body?: { periodDays: number; minOrders: number; shareBps: number }) {
  if (busy.value) return;
  busy.value = true;
  try {
    await api(body ? '/admin/hits/settings' : '/admin/hits/recalculate', { method: body ? 'PATCH' : 'POST', ...(body ? { body } : {}) });
    await refresh();
    toast.add({ title: 'Рейтинг пересчитан', color: 'success' });
  } catch (value) { toast.add({ title: apiError(value), color: 'error' }); }
  finally { busy.value = false; }
}
async function save() {
  const shareBps = rublesToKopecks(share.value);
  if (shareBps === null || shareBps > 10_000) { toast.add({ title: 'Укажите долю от 0,01 до 100%', color: 'error' }); return; }
  await run({ periodDays: periodDays.value, minOrders: minOrders.value, shareBps });
}
async function recalculate() { await run(); }
useOrderPolling(refresh, () => 60_000);
</script>

<style scoped>
.hits { display: grid; gap: 1rem; min-width: 0; }
.hits__settings, .hits__filters { display: grid; gap: 0.75rem; align-items: end; min-width: 0; }
.hits__actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.75rem; }
.hits__table { overflow-x: auto; border: 1px solid var(--ui-border); border-radius: 0.5rem; }
.hits__table table { width: 100%; min-width: 640px; font-size: 0.875rem; text-align: left; }
.hits__table th, .hits__table td { padding: 0.75rem; border-bottom: 1px solid var(--ui-border); }
@media (min-width: 48rem) { .hits__settings { grid-template-columns: repeat(3, minmax(0, 1fr)); } .hits__filters { grid-template-columns: 1fr 1fr auto; } }
</style>
