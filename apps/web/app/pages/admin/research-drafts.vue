<template>
  <section class="research-drafts">
    <h2 class="text-2xl font-semibold">Черновики Багратионовского рынка</h2>
    <p class="text-muted">Исследовательские записи для ручной проверки. Они не являются товарами для заказа и не отображаются покупателям.</p>
    <UAlert color="warning" title="Цены МясБерри — справочные онлайн-цены, не цены этой точки. Для Былинкино цены неизвестны." />
    <UAlert v-if="error" color="error" :title="apiError(error)" />
    <p v-if="pending">Загружаем черновики…</p>
    <template v-else-if="data">
      <div class="research-drafts__toolbar">
        <UButton :variant="mode === 'stores' ? 'solid' : 'outline'" @click="mode = 'stores'">Торговые точки ({{ data.stores.length }})</UButton>
        <UButton :variant="mode === 'products' ? 'solid' : 'outline'" @click="mode = 'products'">Товары ({{ data.products.length }})</UButton>
        <UInput v-model="search" icon="i-lucide-search" placeholder="Найти черновик" class="research-drafts__search" />
      </div>
      <p role="status">Найдено: {{ mode === 'stores' ? filteredStores.length : filteredProducts.length }}</p>

      <UCard v-for="item in mode === 'stores' ? filteredStores : []" :key="item.key">
        <div class="research-drafts__row">
          <div class="research-drafts__main">
            <h3 class="font-semibold">{{ item.source.name }}</h3>
            <p class="text-sm text-muted">{{ item.source.address }} · {{ item.source.pavilion ?? 'Павильон не подтверждён' }} · этаж {{ item.source.floor }}</p>
            <p class="text-sm">Основание адреса: {{ item.source.addressEvidenceStatus }}. Факт работы точки не подтверждён.</p>
            <p v-if="item.source.possibleExistingPointSlugs.length" class="text-sm">Проверить существующие точки: {{ item.source.possibleExistingPointSlugs.join(', ') }}</p>
          </div>
          <UBadge :color="statusColor(item.review.status)">{{ statusLabel(item.review.status) }}</UBadge>
        </div>
        <details><summary>Исходные сведения и проверки</summary><pre class="research-drafts__json">{{ JSON.stringify(item.source, null, 2) }}</pre></details>
        <UTextarea v-model="notes[item.key]" :placeholder="item.review.notes ?? 'Комментарий для проверки'" class="w-full" />
        <div class="research-drafts__actions">
          <UButton :loading="saving === item.key" @click="save('stores', item, 'VERIFIED')">Проверено</UButton>
          <UButton variant="outline" color="error" :loading="saving === item.key" @click="save('stores', item, 'REJECTED')">Отклонить</UButton>
          <UButton variant="ghost" :loading="saving === item.key" @click="save('stores', item, 'PENDING')">Оставить на проверку</UButton>
        </div>
      </UCard>

      <UCard v-for="item in mode === 'products' ? filteredProducts : []" :key="item.key">
        <div class="research-drafts__row">
          <div class="research-drafts__main">
            <h3 class="font-semibold">{{ item.source.name }}</h3>
            <p class="text-sm text-muted">{{ item.source.supplierKey }} · {{ item.source.category }} · {{ item.source.milkType ?? 'Без уточнения варианта' }}</p>
            <p v-if="item.source.referencePrice" class="text-sm">
              Справочная онлайн-цена: {{ rubles(item.source.referencePrice.amountKopecks) }} / {{ item.source.referencePrice.priceQty }} г.
              <a :href="item.source.sourceUrl" target="_blank" rel="noopener noreferrer" class="underline">Источник</a>
            </p>
            <p v-else class="text-sm">Цена продажи неизвестна. <a :href="item.source.sourceUrl" target="_blank" rel="noopener noreferrer" class="underline">Источник</a></p>
            <p class="text-sm">Цена магазина, остаток, SKU и условия продажи требуют подтверждения.</p>
          </div>
          <UBadge :color="statusColor(item.review.status)">{{ statusLabel(item.review.status) }}</UBadge>
        </div>
        <details><summary>Исходные сведения и проверки</summary><pre class="research-drafts__json">{{ JSON.stringify({ source: item.source, sale: item.sale }, null, 2) }}</pre></details>
        <UTextarea v-model="notes[item.key]" :placeholder="item.review.notes ?? 'Комментарий для проверки'" class="w-full" />
        <div class="research-drafts__actions">
          <UButton :loading="saving === item.key" @click="save('products', item, 'VERIFIED')">Проверено</UButton>
          <UButton variant="outline" color="error" :loading="saving === item.key" @click="save('products', item, 'REJECTED')">Отклонить</UButton>
          <UButton variant="ghost" :loading="saving === item.key" @click="save('products', item, 'PENDING')">Оставить на проверку</UButton>
        </div>
      </UCard>
      <p v-if="mode === 'stores' && !filteredStores.length || mode === 'products' && !filteredProducts.length">Ничего не найдено.</p>
    </template>
  </section>
</template>

<script setup lang="ts">
definePageMeta({ middleware: 'admin', layout: 'admin' });

type Status = 'PENDING' | 'VERIFIED' | 'REJECTED';
type Review = { status: Status; notes: string | null; reviewedOn: string | null };
type StoreSource = {
  name: string; address: string; floor: number; pavilion: string | null;
  addressEvidenceStatus: string; possibleExistingPointSlugs: string[];
};
type PriceReference = { amountKopecks: number; priceQty: number };
type ProductSource = {
  name: string; supplierKey: string; category: string; milkType: string | null;
  sourceUrl: string; referencePrice: PriceReference | null;
};
type Draft<S> = { key: string; updatedAt: string; source: S; review: Review };
type StoreDraft = Draft<StoreSource>;
type ProductDraft = Draft<ProductSource> & { sale: Record<string, unknown> };
type Data = { datasetId: string; stores: StoreDraft[]; products: ProductDraft[] };

const { data, pending, error, refresh } = await useApi<Data>('/admin/research-drafts');
const api = useApiClient();
const toast = useToast();
const mode = ref<'stores' | 'products'>('stores');
const search = ref('');
const saving = ref<string | null>(null);
const notes = reactive<Record<string, string>>({});
const normalized = computed(() => search.value.toLocaleLowerCase('ru-RU').trim());
const filteredStores = computed(() => (data.value?.stores ?? []).filter(item =>
  `${item.source.name} ${item.source.address} ${item.key}`.toLocaleLowerCase('ru-RU').includes(normalized.value)));
const filteredProducts = computed(() => (data.value?.products ?? []).filter(item =>
  `${item.source.name} ${item.source.category} ${item.source.supplierKey} ${item.key}`.toLocaleLowerCase('ru-RU').includes(normalized.value)));
const rubles = (kopecks: number) => `${(kopecks / 100).toLocaleString('ru-RU')} ₽`;
const statusLabel = (status: Status) => ({ PENDING: 'Не проверено', VERIFIED: 'Проверено', REJECTED: 'Отклонено' })[status];
const statusColor = (status: Status): 'success' | 'error' | 'neutral' =>
  ({ PENDING: 'neutral' as const, VERIFIED: 'success' as const, REJECTED: 'error' as const })[status];
async function save(kind: 'stores' | 'products', item: StoreDraft | ProductDraft, status: Status) {
  if (saving.value) return;
  saving.value = item.key;
  try {
    await api(`/admin/research-drafts/${kind}/${encodeURIComponent(item.key)}`, {
      method: 'PATCH',
      body: { status, notes: notes[item.key] ?? item.review.notes, expectedUpdatedAt: item.updatedAt },
    });
    await refresh();
    toast.add({ title: 'Проверка сохранена', color: 'success' });
  } catch (value) {
    await refresh();
    toast.add({ title: apiError(value), color: 'error' });
  } finally {
    saving.value = null;
  }
}
</script>

<style scoped>
.research-drafts { display: grid; gap: 1rem; }
.research-drafts__toolbar, .research-drafts__row, .research-drafts__actions { display: flex; flex-wrap: wrap; align-items: center; gap: .75rem; }
.research-drafts__main { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.research-drafts__search { flex: 1; min-width: 12rem; }
.research-drafts__json { max-height: 18rem; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-size: .75rem; padding: .5rem; }
.research-drafts details { margin-block: .75rem; }
</style>
