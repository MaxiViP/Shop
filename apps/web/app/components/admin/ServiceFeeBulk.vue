<template>
  <UCard>
    <template #header><h3 class="font-semibold">Массовое управление сервисным вознаграждением</h3></template>
    <div class="space-y-4 min-w-0">
      <p class="text-sm text-muted">Изменение сервисного процента повлияет на цены товаров в каталоге. Ранее оформленные заказы останутся без изменений</p>
      <UFormField label="Товары для перевода">
        <USelect v-model="scope" aria-label="Товары для перевода" :items="scopes" :disabled="busy" class="w-full sm:max-w-lg" />
      </UFormField>
      <p v-if="scope === 'filter'" class="text-sm text-muted">Используется применённый фильтр списка, включая поиск, категорию и режим. Отмеченные ниже флажки при этом не учитываются.</p>
      <p v-if="scope === 'individual'" class="text-sm text-muted">В выборку войдут и подтверждённые исключения, включая 0%. Проверьте каждое изменение в предварительном расчёте.</p>
      <p class="text-sm text-muted">До 1000 товаров за одну операцию. Отмеченные товары сохраняются между страницами.</p>
      <p role="status">{{ countPending ? 'Подсчёт товаров…' : `Выбрано товаров: ${selectedCount ?? 'не удалось определить'}` }}</p>
      <div class="flex flex-wrap gap-3">
        <UButton :loading="previewBusy" :disabled="busy || pending || countPending || !selectedCount" @click="loadPreview">Перевести на общий процент</UButton>
        <UButton v-if="ids.length" color="neutral" variant="outline" :disabled="busy" @click="ids = []">Снять выбор процентов ({{ ids.length }})</UButton>
      </div>
      <UAlert v-if="error && !open" color="error" :title="error" />
      <UButton v-if="error && !open && !countPending" variant="outline" @click="countRevision++">Обновить количество</UButton>
      <UAlert v-if="result" color="success" :title="`Обновлено товаров: ${result.changedCount} из ${result.count}. Без изменений: ${result.skippedCount}.`" />
    </div>
    <UModal v-model:open="open" title="Предварительный расчёт сервисного процента" description="Проверьте цены и подтвердите перевод выбранного набора на общую настройку." :dismissible="!busy" :ui="{ content: 'sm:max-w-4xl', header: 'shrink-0', wrapper: 'min-w-0 pe-8', footer: 'shrink-0' }">
      <template #body>
        <div class="space-y-4 min-w-0">
          <UAlert v-if="error" color="error" :title="error" />
          <UAlert v-if="outdated" color="warning" title="Предварительный расчёт нужно обновить" />
          <UButton variant="outline" :loading="previewBusy" :disabled="applyBusy" @click="loadPreview">Обновить предварительный расчёт</UButton>
          <template v-if="preview">
            <p class="font-semibold">Товаров: {{ preview.count }} · Изменится: {{ preview.changedCount }} · Общий процент: {{ preview.globalPercent }}%</p>
            <p class="text-sm text-muted">Действует до {{ new Date(preview.expiresAt).toLocaleTimeString('ru-RU') }}. Итоги ниже — сумма цен за указанные единицы товаров, не стоимость заказа.</p>
            <dl class="grid gap-2 text-sm sm:grid-cols-[minmax(0,1fr)_auto]">
              <dt>Было</dt><dd>{{ money(preview.totals.beforePrice) }}</dd>
              <dt>Будет</dt><dd>{{ money(preview.totals.afterPrice) }}</dd>
              <dt>Разница</dt><dd>{{ money(preview.totals.difference) }} ({{ bpsPercent(preview.totals.differenceBps) }}%)</dd>
            </dl>
            <article v-for="row in visibleRows" :key="row.id" class="rounded-lg border border-default p-3 space-y-2 min-w-0" :aria-label="`Изменение товара ${row.id}`">
              <h4 class="font-semibold break-words">#{{ row.id }} · {{ row.name }}</h4>
              <UBadge v-if="row.before.needsReview" color="warning" variant="soft">Требует проверки</UBadge>
              <p class="text-sm text-muted">Цена за {{ row.priceQty }} {{ units[row.unit] }}. Продавец: {{ money(row.sellerPrice) }}</p>
              <dl class="grid gap-1 text-sm">
                <div><dt class="inline">Было: </dt><dd class="inline">{{ row.before.mode === 'global' ? 'Общий' : 'Индивидуальный' }} · {{ row.before.percent }}% · {{ money(row.before.customerPrice) }}</dd></div>
                <div><dt class="inline">Будет: </dt><dd class="inline">Общий · {{ row.after.percent }}% · {{ money(row.after.customerPrice) }}</dd></div>
                <div><dt class="inline">Разница: </dt><dd class="inline">{{ money(row.difference) }} ({{ bpsPercent(row.differenceBps) }}%)</dd></div>
              </dl>
              <p v-if="!row.changed" class="text-sm text-muted">Уже использует общий процент, запись не изменится.</p>
            </article>
            <div class="flex flex-wrap items-center gap-3">
              <UButton variant="outline" :disabled="previewPage <= 1 || busy" @click="previewPage--">Предыдущие</UButton>
              <span>Страница {{ previewPage }} / {{ previewPages }}</span>
              <UButton variant="outline" :disabled="previewPage >= previewPages || busy" @click="previewPage++">Следующие</UButton>
            </div>
            <UCheckbox v-model="confirmed" :disabled="busy || outdated || !preview.changedCount" label="Подтверждаю изменение цен и очистку индивидуальных процентов у выбранных товаров" />
          </template>
        </div>
      </template>
      <template #footer>
        <div class="flex flex-wrap gap-3">
          <UButton color="neutral" variant="outline" :disabled="busy" @click="open = false">Отмена</UButton>
          <UButton :loading="applyBusy" :disabled="busy || outdated || !confirmed || !preview?.changedCount" @click="applyPreview">Подтвердить перевод</UButton>
        </div>
      </template>
    </UModal>
  </UCard>
</template>

<script setup lang="ts">
import type { AdminPage, AdminProduct } from '~/types/admin';
import type { ServiceFeeFilter, BulkSelection, BulkFeePreview, BulkFeeResult } from '~/types/service-fee';
import { serviceFeeConflict, serviceFeeError } from '~/utils/service-fee';
const props = defineProps<{ filter: ServiceFeeFilter; total: number; pending: boolean }>();
const ids = defineModel<number[]>('ids', { required: true });
const emit = defineEmits<{ applied: [result: BulkFeeResult] }>();
const scope = ref('ids');
const scopes = [
  { label: 'Отмеченные товары', value: 'ids' }, { label: 'Все требующие проверки', value: 'review' },
  { label: 'Все с индивидуальным процентом', value: 'individual' }, { label: 'Все по применённому фильтру списка', value: 'filter' },
];
const selection = computed<BulkSelection>(() => scope.value === 'ids' ? { kind: 'ids', ids: [...ids.value] } : {
  kind: 'filter', filter: scope.value === 'filter' ? { ...props.filter } : { serviceFeeMode: scope.value === 'review' ? 'review' : 'individual' },
});
const api = useApiClient();
const filterCount = ref<number | null>(null), countPending = ref(false), countRevision = ref(0);
const selectedCount = computed(() => scope.value === 'ids' ? ids.value.length : scope.value === 'filter' ? props.total : filterCount.value);
const previewBusy = ref(false), applyBusy = ref(false), busy = computed(() => previewBusy.value || applyBusy.value);
const preview = ref<BulkFeePreview | null>(null), result = ref<BulkFeeResult | null>(null);
const open = ref(false), confirmed = ref(false), outdated = ref(false), error = ref(''), requestId = ref('');
const previewPage = ref(1), previewPages = computed(() => Math.max(1, Math.ceil((preview.value?.count ?? 0) / 20)));
const visibleRows = computed(() => preview.value?.rows.slice((previewPage.value-1)*20,previewPage.value*20) ?? []);
const units = { GRAM: 'г', PIECE: 'шт.', BUNCH: 'пуч.', PACK: 'уп.' };
watch(() => [selection.value, countRevision.value] as const, async ([value], _previous, onCleanup) => {
  preview.value = null; confirmed.value = false; error.value = ''; outdated.value = false;
  let active = true; onCleanup(() => { active = false; });
  filterCount.value = null;
  countPending.value = false;
  if (scope.value !== 'review' && scope.value !== 'individual') return;
  countPending.value = true;
  try {
    const response = await api<AdminPage<AdminProduct>>('/admin/products', { query: { ...(value.kind === 'filter' ? value.filter : {}), page: 1, limit: 1 } });
    if (active) filterCount.value = response.total;
  } catch (cause) { if (active) error.value = serviceFeeError(cause); }
  finally { if (active) countPending.value = false; }
}, { deep: true });
watch(open, value => { if (!value) confirmed.value = false; });
async function loadPreview() {
  if (busy.value || props.pending || countPending.value || !selectedCount.value) return;
  previewBusy.value = true; error.value = ''; confirmed.value = false; outdated.value = false;
  const selected = selection.value;
  const selectionKey = JSON.stringify(selected);
  try {
    const response = await api<BulkFeePreview>('/admin/products/service-fee/bulk/preview', { method: 'POST', body: { selection: selected, mode: 'global' } });
    if (selectionKey !== JSON.stringify(selection.value)) { error.value = 'Выбор изменился. Запросите предварительный расчёт заново.'; return; }
    preview.value = response; requestId.value = crypto.randomUUID(); previewPage.value = 1; open.value = true;
  } catch (cause) { error.value = serviceFeeError(cause); outdated.value = true; }
  finally { previewBusy.value = false; }
}
async function applyPreview() {
  if (busy.value || !confirmed.value || outdated.value || !preview.value?.changedCount) return;
  applyBusy.value = true; error.value = '';
  try {
    const response = await api<BulkFeeResult>('/admin/products/service-fee/bulk/apply', { method: 'POST', body: { previewToken: preview.value.previewToken, requestId: requestId.value, confirmed: true } });
    result.value = response; open.value = false; ids.value = []; preview.value = null; scope.value = 'ids';
    emit('applied', response);
  } catch (cause) {
    error.value = serviceFeeError(cause);
    const code = (cause as { data?: { code?: string } })?.data?.code;
    outdated.value = serviceFeeConflict(cause) && code !== 'SERVICE_FEE_IN_PROGRESS';
  } finally { applyBusy.value = false; }
}
</script>
