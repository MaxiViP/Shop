<template>
  <form class="space-y-6" @submit.prevent="save">
    <fieldset :disabled="busy" class="space-y-6">
      <UCard>
        <template #header><h2 class="font-semibold">Основное</h2></template>
        <div class="grid sm:grid-cols-2 gap-4">
          <UFormField label="Название товара" required
            ><AppTextInput
              v-model="form.name"
              required
              maxlength="160"
              class="w-full"
              @update:model-value="generateSlug"
          /></UFormField>
          <UFormField label="Slug" required
            ><UInput
              v-model="form.slug"
              required
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              maxlength="180"
              class="w-full"
              @input="manualSlug = true"
            /><UButton
              size="xs"
              variant="link"
              @click="
                form.slug = productSlug(form.name);
                manualSlug = false;
              "
              >Из названия</UButton
            ></UFormField
          >
          <UFormField label="Описание" class="sm:col-span-2"
            ><UTextarea
              v-model="form.description"
              maxlength="10000"
              class="w-full"
          /></UFormField>
          <UFormField label="Категория" required
            ><USelect
              v-model="form.categoryId"
              :items="categoryItems"
              class="w-full"
              placeholder="Выберите категорию"
          /></UFormField>
        </div>
      </UCard>
      <UCard>
        <template #header
          ><h2 class="font-semibold">Цена и количество</h2></template
        >
        <div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <UFormField label="Способ продажи" :error="quantityError.saleModel" help="Нарезку, фасовку и оценочный вес подтвердите у продавца. Выбор режима не изменяет цену, единицы и количества автоматически."><USelect v-model="form.saleModel" :items="saleOptions" value-key="value" class="w-full" /></UFormField>
          <UAlert v-if="saleChanged" class="sm:col-span-2 lg:col-span-3" color="warning" title="Изменяются условия продажи">
            <template #description>
              <p>Проверьте цену за указанную единицу, минимальный заказ, шаг и порцию. Прежняя цена автоматически не пересчитывается.</p>
              <UCheckbox v-model="saleConfirmed" label="Условия подтверждены продавцом; цена и количества проверены" class="mt-3" />
            </template>
          </UAlert>
          <UFormField label="Цена продавца, ₽" required help="Исходная цена без сервиса KorzinaMarket."
            ><UInput
              v-model="rubles"
              inputmode="decimal"
              required
              placeholder="199,50"
              class="w-full"
          /></UFormField>
          <UFormField label="Единица"
            ><USelect v-model="form.unit" :items="units" class="w-full"
          /></UFormField>
          <UFormField v-if="!owner" label="Достоверность цены" help="Статус относится к цене продавца; сервис добавляется автоматически.">
            <USelect v-model="form.priceStatus" :items="priceStatusItems" class="w-full" />
          </UFormField>
          <UFormField label="Единица цены" :error="quantityError.priceQty"><USelect v-model="form.priceUnit" :items="units" class="w-full" /></UFormField>
          <UFormField v-if="variableWeight(form)" label="Название экземпляра"><USelect v-model="form.wholeLabel" :items="[...wholeLabels]" class="w-full" /></UFormField>
          <UFormField v-if="variableWeight(form)" label="Оценочный вес одного экземпляра, г" :error="quantityError.estimatedWeightGrams" help="Только подтвержденная оценка продавца. Оставьте пустым, если вес неизвестен."><UInput v-model="estimate" type="number" min="1" :max="MAX_QTY" class="w-full" /></UFormField>
          <UFormField :label="`Цена за количество (${priceQuantityLabel})`"
            ><UInput
              v-model.number="form.priceQty"
              type="number"
              min="1"
              :max="MAX_QTY"
              step="1"
              required
              class="w-full"
          /></UFormField>
          <UFormField :label="`Минимальный заказ (${quantityLabel})`" :error="quantityError.min" help="Меньше этого количества купить нельзя."
            ><UInput
              v-model.number="form.min"
              type="number"
              min="1"
              :max="MAX_QTY"
              step="1"
              required
              class="w-full"
          /></UFormField>
          <UFormField :label="`Шаг изменения (${quantityLabel})`" :error="quantityError.step" help="На столько меняется количество кнопками + и −."
            ><UInput
              v-model.number="form.step"
              type="number"
              min="1"
              :max="MAX_QTY"
              step="1"
              required
              class="w-full"
          /></UFormField>
          <UFormField :label="`Первое добавление (${quantityLabel})`" :error="quantityError.portionQty" help="Первое нажатие добавляет порцию; следующие + и − используют шаг."
            ><UInput
              v-model.number="form.portionQty"
              type="number"
              min="1"
              :max="MAX_QTY"
              step="1"
              required
              class="w-full"
          /></UFormField>
        </div>
        <section v-if="!owner" class="mt-6 rounded-lg border border-primary/30 p-4 space-y-4 min-w-0" aria-labelledby="service-fee-title">
          <h3 id="service-fee-title" class="font-semibold">Сервисное вознаграждение</h3>
          <UAlert v-if="feeNeedsReview" color="warning" title="Требует проверки" description="Процент перенесён из старой системы. Проверьте, должен ли товар использовать индивидуальную или общую настройку" />
          <UAlert v-if="settingsError" color="error" :title="serviceFeeError(settingsError)" />
          <div class="flex flex-wrap items-center gap-3">
            <p v-if="globalPercent !== null">Глобальный процент: <strong>{{ globalPercent }}%</strong></p>
            <p v-else role="status">Общий процент недоступен</p>
            <UButton size="xs" variant="ghost" :loading="settingsPending" :disabled="busy" @click="refreshServiceFee">Обновить процент</UButton>
          </div>
          <UFormField label="Режим сервисного вознаграждения">
            <USelect aria-label="Режим сервисного вознаграждения" :model-value="feeMode" :items="feeModes" class="w-full sm:max-w-xs" @update:model-value="selectFeeMode" />
          </UFormField>
          <UFormField v-if="feeMode === 'individual'" label="Индивидуальный процент, %" :error="feeValidation" help="Целое число от 0 до 100%. Можно указать 0%." required>
            <UInput v-model="individualPercent" aria-label="Индивидуальный процент, %" type="number" min="0" max="100" step="1" required class="w-full sm:max-w-48" />
          </UFormField>
          <UCheckbox v-if="feeNeedsReview && feeMode === 'individual'" v-model="reviewConfirmed" label="Проверено: сохранить индивидуальный процент" />
          <p class="text-sm text-muted">Процент включён в цену покупателя. Изменение применяется к новым заказам.</p>
          <p v-if="pricing" role="status">Эффективный процент: <strong>{{ pricing.serviceMarkupPercent }}%</strong></p>
        </section>
        <dl v-if="pricing" class="mt-4 grid grid-cols-[minmax(0,1fr)_auto] gap-2 text-sm max-w-md" aria-live="polite">
          <dt>Цена продавца</dt><dd>{{ money(pricing.sellerPrice) }}</dd>
          <dt>Сервис {{ pricing.serviceMarkupPercent }}%</dt><dd>{{ money(pricing.serviceMarkup) }}</dd>
          <dt>Цена покупателя</dt><dd>{{ money(pricing.customerPrice) }}</dd>
        </dl>
        <p v-else-if="rublesToKopecks(rubles) !== null" class="mt-4 text-sm text-muted" aria-live="polite">{{ pricingError || 'Цена покупателя рассчитывается…' }}</p>
        <div v-if="preview" class="mt-4 space-y-1 text-sm text-muted" aria-live="polite">
          <h3 class="font-semibold text-default">Настройки количества</h3>
          <p>Минимум: {{ qtyText(form.unit, form.min) }} · Шаг: {{ qtyText(form.unit, form.step) }} · Быстро добавить: {{ qtyText(form.unit, form.portionQty) }}</p>
          <p>Каталог: {{ preview.quick }}</p>
          <p>Изменение количества: {{ preview.manual }}</p>
        </div>
      </UCard>
      <UCard v-if="!owner">
        <template #header><h2 class="font-semibold">Внутренний расчёт</h2></template>
        <div class="space-y-4">
          <UFormField label="Режим расчёта">
            <USelect v-model="settlementMode" :items="settlementOptions" class="w-full max-w-md" />
          </UFormField>
          <template v-if="settlementMode === 'SHARED_MARKUP'">
            <UFormField label="Базовая цена для расчёта, ₽" required>
              <UInput v-model="baseRubles" inputmode="decimal" required class="w-full max-w-md" />
            </UFormField>
            <p class="text-sm text-muted">Используется только во внутренней финансовой отчётности. Покупатели эту цену не видят.</p>
            <dl v-if="settlementPreview" class="grid grid-cols-2 gap-2 text-sm max-w-md">
              <dt>Цена продажи</dt><dd>{{ money(settlementPreview.sale) }}</dd>
              <dt>Базовая цена</dt><dd>{{ money(settlementPreview.base) }}</dd>
              <dt>Наценка</dt><dd :class="settlementPreview.markup < 0 ? 'text-error' : 'text-success'">{{ money(settlementPreview.markup) }}</dd>
              <dt>Партнёр 1</dt><dd>{{ money(settlementPreview.partner1) }}</dd>
              <dt>Партнёр 2</dt><dd>{{ money(settlementPreview.partner2) }}</dd>
            </dl>
          </template>
          <UAlert v-else-if="settlementMode === 'NO_MARKUP'" color="neutral" title="Товар не участвует в распределении наценки." />
          <UAlert v-else color="warning" title="Финансовый расчёт товара ещё не настроен." />
        </div>
      </UCard>
      <UCard>
        <template #header><h2 class="font-semibold">Где покупаем и источник цены</h2></template>
        <div class="grid sm:grid-cols-2 gap-4">
          <UFormField label="Торговая точка">
            <USelect v-model="form.marketPointId" :items="pointItems" class="w-full" />
          </UFormField>
          <UFormField v-if="!owner" label="Проверено">
            <UInput v-model="checkedDate" type="date" class="w-full" />
          </UFormField>
          <UFormField v-if="!owner" label="Источник цены продавца" class="sm:col-span-2">
            <UInput v-model="form.sourceUrl" type="url" maxlength="2000" placeholder="https://…" class="w-full" />
            <a v-if="source?.sourceUrl" :href="source.sourceUrl" target="_blank" rel="noopener noreferrer" class="text-sm text-primary underline">Открыть источник</a>
          </UFormField>
        </div>
      </UCard>
      <UCard>
        <template #header><h2 class="font-semibold">Публикация</h2></template>
        <div v-if="!owner" class="grid sm:grid-cols-2 gap-4 mb-6">
          <fieldset class="sm:col-span-2 grid gap-3">
            <legend class="font-semibold">ХИТ</legend>
            <UFormField label="Отметка ХИТ"><USelect v-model="form.hitMode" :items="hitModes" class="w-full" /></UFormField>
            <p class="text-sm text-muted">{{ hitBadge ? 'Будет показана отметка «ХИТ».' : 'Отметка «ХИТ» выключена.' }} Автоматический результат: {{ source?.autoHit ? 'ХИТ' : 'без отметки' }}. <NuxtLink to="/admin/hits" class="text-primary underline">Рейтинг продаж</NuxtLink></p>
          </fieldset>
          <fieldset class="sm:col-span-2 grid gap-3 sm:grid-cols-2">
            <legend class="font-semibold">СЕЗОН</legend>
            <UFormField label="Сезонность"><USelect v-model="form.seasonalMode" :items="seasonModes" class="w-full" /></UFormField>
            <UFormField label="Календарный шаблон" :required="form.seasonalMode === 'AUTO'"><USelectMenu v-model="form.seasonTemplateId" :items="seasonItems" value-key="value" :search-input="{ placeholder: 'Найти шаблон по названию или группе' }" class="w-full" /></UFormField>
            <p class="sm:col-span-2 text-sm text-muted">{{ seasonTemplates?.find(item => item.id === form.seasonTemplateId)?.description ?? 'Выбирайте шаблон с учётом происхождения партии: местный, региональный, тепличный или импортный урожай.' }}</p>
          </fieldset>
          <p class="sm:col-span-2 text-sm text-muted">Автоматический режим повторяется каждый год по календарю Москвы. Отключённый шаблон не включает отметку.</p>
        </div>
        <div class="flex flex-wrap gap-6 items-center">
          <USwitch v-model="form.active" label="Товар опубликован" />
          <UFormField v-if="!owner" label="Порядок"
            ><UInput
              v-model.number="form.sort"
              type="number"
              min="-1000000"
              max="1000000"
              step="1"
              required
          /></UFormField>
        </div>
      </UCard>
      <UAlert v-if="error" color="error" :title="error" />
      <div class="flex flex-wrap gap-3">
        <UButton type="submit" :loading="busy">{{
          product ? "Сохранить изменения" : "Создать товар"
        }}</UButton
        ><UButton :to="listPath" color="neutral" variant="outline"
          >К списку</UButton
        >
      </div>
    </fieldset>
    <UModal v-model:open="confirmGlobal" title="Перейти на общий процент?" description="Индивидуальное значение будет очищено при сохранении. Цена товара будет зависеть от текущего и последующих изменений общего процента.">
      <template #footer>
        <div class="flex flex-wrap gap-3">
          <UButton color="neutral" variant="outline" @click="confirmGlobal = false">Отмена</UButton>
          <UButton @click="useGlobalFee">Использовать общий процент</UButton>
        </div>
      </template>
    </UModal>
  </form>
  <UCard class="mt-6">
    <AdminImages
      v-if="product"
      :product-id="product.id"
      :api-root="apiRoot"
      :product-name="product.name"
      :value="product.images"
      @refresh="$emit('refresh')"
    />
    <p v-else class="text-muted">
      Фотографии можно загрузить сразу после создания товара.
    </p>
  </UCard>
</template>

<script setup lang="ts">
import type { AdminProduct, AdminCategory, ProductPricing } from "~/types/admin";
import type { MarketPoint } from "~/types/market-map";
import { priceStatusItems } from "~/utils/price-status";
import type { Unit } from "~/types/product";
import { servicePercent, serviceFeeError } from '~/utils/service-fee';
import { MAX_QTY, manualQuantity, quantityErrors } from "~/utils/assembly";
import { qtyText } from "~/utils/qty";
import { priceUnit, saleErrors, saleTermsChanged, variableWeight, wholeLabels, type SaleModel } from '~/utils/sale';
import { nextCartQty } from '~/utils/cart';
import type { HitMode, SeasonalMode, SeasonTemplate } from '~/types/badges';
import { hitModes, seasonGroupLabel } from '~/utils/badges';
const props = defineProps<{
  product?: AdminProduct;
  owner?: boolean;
  categories: AdminCategory[];
}>();
const emit = defineEmits<{ refresh: [] }>();
const source = props.product;
const apiRoot = props.owner ? '/owner/products' : '/admin/products';
const listPath = props.owner ? '/staff/products' : '/admin/products';
const form = reactive({
  name: source?.name ?? "",
  slug: source?.slug ?? "",
  description: source?.description ?? "",
  categoryId: source?.categoryId ?? (undefined as number | undefined),
  marketPointId: source?.marketPointId ?? 0,
  priceStatus: source?.priceStatus ?? 'ESTIMATED',
  sourceUrl: source?.sourceUrl ?? "",
  priceQty: source?.priceQty ?? 1,
  unit: source?.unit ?? ("PIECE" as Unit),
  min: source?.min ?? 1,
  step: source?.step ?? 1,
  portionQty: source?.portionQty ?? source?.min ?? 1,
  saleModel: source?.saleModel ?? null as SaleModel | null,
  priceUnit: source?.priceUnit ?? source?.unit ?? 'PIECE' as Unit,
  wholeLabel: (source?.wholeLabel ?? 'шт.') as typeof wholeLabels[number],
  estimatedWeightGrams: source?.estimatedWeightGrams ?? null as number | null,
  active: source?.active ?? true,
  hitMode: source?.hitMode ?? ('AUTO' as HitMode),
  seasonalMode: source?.seasonalMode ?? ('OFF' as SeasonalMode),
  seasonTemplateId: source?.seasonTemplateId ?? 0,
  sort: source?.sort ?? 0,
});
const rubles = ref(source ? kopecksToRubles(source.price) : "");
const estimate = ref(source?.estimatedWeightGrams?.toString() ?? '');
watch(estimate, value => { form.estimatedWeightGrams = value === '' ? null : Number(value); });
const saleOptions = [
  { label: 'Существующий режим', value: null },
  { label: 'На развес', value: 'WEIGHT_LOOSE' }, { label: 'Поштучно', value: 'PIECE_FIXED' },
  { label: 'Пучками', value: 'BUNCH' }, { label: 'Упаковками', value: 'PACK' },
  { label: 'Целиком с взвешиванием', value: 'WHOLE_VARIABLE_WEIGHT' }, { label: 'Нарезка по весу', value: 'CUT_TO_WEIGHT' },
];
const saleConfirmed = ref(false);
const saleChanged = computed(() => Boolean(source && saleTermsChanged(source, form)));
watch(() => [form.saleModel, form.unit, form.priceUnit, form.priceQty, form.min, form.step,
  form.portionQty, form.estimatedWeightGrams, rubles.value], () => { saleConfirmed.value = false; });
const checkedDate = ref(source?.sourceCheckedAt?.slice(0, 10) ?? "");
const pricing = ref<ProductPricing | null>(source ?? null);
const pricingError = ref('');
const feeModes = [{ label: 'Общий процент', value: 'global' }, { label: 'Индивидуальный процент', value: 'individual' }];
const feeMode = ref<'global' | 'individual'>(source?.serviceMarkupPercentOverride != null ? 'individual' : 'global');
const individualPercent = ref(String(source?.serviceMarkupPercentOverride ?? ''));
const feeOverride = computed(() => feeMode.value === 'global' ? null : servicePercent(String(individualPercent.value)));
const feeValidation = computed(() => feeMode.value === 'individual' && feeOverride.value === null ? 'Укажите целое число от 0 до 100%' : undefined);
const originalOverride = ref(source?.serviceMarkupPercentOverride ?? null);
const feeNeedsReview = ref(source?.serviceMarkupNeedsReview ?? false);
const reviewConfirmed = ref(false);
const confirmGlobal = ref(false);
function selectFeeMode(value: unknown) {
  if (value === feeMode.value) return;
  if (value === 'global' && feeMode.value === 'individual') { confirmGlobal.value = true; return; }
  if (value === 'individual') {
    individualPercent.value = String(globalPercent.value ?? source?.serviceMarkupPercent ?? '');
    feeMode.value = 'individual';
  }
}
function useGlobalFee() {
  feeMode.value = 'global';
  individualPercent.value = '';
  confirmGlobal.value = false;
}
const settings = !props.owner ? await useApi<{ globalServiceMarkupPercent: number }>('/admin/settings') : null;
const globalPercent = computed(() => settings?.data.value?.globalServiceMarkupPercent ?? null);
const settingsError = computed(() => settings?.error.value);
const settingsPending = computed(() => settings?.pending.value ?? false);
const pricingRevision = ref(0);
async function refreshServiceFee() {
  if (!settings || settings.pending.value) return;
  await settings.refresh();
  pricingRevision.value++;
}
onMounted(() => { if (!props.owner) window.addEventListener('focus', refreshServiceFee); });
onBeforeUnmount(() => { if (!props.owner) window.removeEventListener('focus', refreshServiceFee); });
const { data: marketPoints } = await useApi<MarketPoint[]>(props.owner ? '/owner/points' : '/admin/market-map/points');
const seasonTemplates = ref<SeasonTemplate[]>([]);
if (!props.owner) {
  const { data } = await useApi<SeasonTemplate[]>('/admin/seasons');
  seasonTemplates.value = data.value ?? [];
}
const seasonModes = [{ label: 'Автоматически по шаблону', value: 'AUTO' }, { label: 'Вручную включить', value: 'MANUAL' }, { label: 'Выключить', value: 'OFF' }];
const hitBadge = computed(() => form.hitMode === 'MANUAL' || (form.hitMode === 'AUTO' && source?.autoHit === true));
const seasonItems = computed(() => [{ label: 'Без шаблона', value: 0 }, ...(seasonTemplates.value ?? []).map(template => ({
  label: `${template.name} · ${seasonGroupLabel(template.group)}${template.active ? '' : ' (отключён)'}`, value: template.id,
}))]);
const pointItems = computed(() => [
  ...(props.owner ? [] : [{ label: "Без торговой точки", value: 0 }]),
  ...(marketPoints.value ?? []).filter(point => point.kind !== "ENTRY").map(point => ({ label: point.name, value: point.id })),
]);
if (props.owner && !form.marketPointId) form.marketPointId = marketPoints.value?.[0]?.id ?? 0;
const settlementMode = ref<AdminProduct["settlementMode"]>(source?.settlementMode ?? "UNSET");
const baseRubles = ref(source?.basePrice ? kopecksToRubles(source.basePrice) : "");
const settlementOptions = [
  { label: "Не настроено", value: "UNSET" },
  { label: "Общая наценка 50/50", value: "SHARED_MARKUP" },
  { label: "Без наценки", value: "NO_MARKUP" },
];
const settlementPreview = computed(() => {
  const sale = pricing.value?.customerPrice ?? null;
  const base = rublesToKopecks(baseRubles.value);
  if (settlementMode.value !== "SHARED_MARKUP" || sale === null || base === null) return null;
  const markup = sale - base;
  const partner1 = Math.trunc(markup / 2);
  return { sale, base, markup, partner1, partner2: markup - partner1 };
});
const manualSlug = ref(Boolean(source));
const units = [
  { label: "Весовой", value: "GRAM" },
  { label: "Штука", value: "PIECE" },
  { label: "Пучок", value: "BUNCH" },
  { label: "Упаковка", value: "PACK" },
];
const quantityLabel = computed(
  () => ({ GRAM: "г", PIECE: "шт.", BUNCH: "пуч.", PACK: "уп." })[form.unit],
);
const priceQuantityLabel = computed(() => ({ GRAM: 'г', PIECE: 'шт.', BUNCH: 'пуч.', PACK: 'уп.' })[priceUnit(form)]);
const quantityError = computed<Record<string, string | undefined>>(() => ({ ...quantityErrors(form), ...saleErrors({ ...form, wholeLabel: variableWeight(form) ? form.wholeLabel : null }) }));
const preview = computed(() => {
  if (Object.keys(quantityError.value).length) return null;
  const quick: number[] = [];
  const manual = [form.min];
  for (let i = 0; i < 3; i++) {
    const next = nextCartQty(quick.at(-1), form);
    if (next !== null) quick.push(next);
    if (i < 2) {
      const nextManual = manualQuantity(manual.at(-1)!, form, 1);
      if (nextManual !== null) manual.push(nextManual);
    }
  }
  const format = (values: number[]) => values.map(value => qtyText(form.unit, value)).join(' → ');
  return { quick: format(quick), manual: format(manual) };
});
const categoryItems = computed(() =>
  props.categories.map((category) => ({
    label: category.name + (category.active ? "" : " (скрыта)"),
    value: category.id,
  })),
);
function generateSlug() {
  if (!manualSlug.value) form.slug = productSlug(form.name);
}
const api = useApiClient();
function acceptPricing(result: ProductPricing) {
  if (!props.owner && result.serviceMarkupPercentOverride === null && settings?.data.value) {
    settings.data.value.globalServiceMarkupPercent = result.serviceMarkupPercent;
  }
  pricing.value = result;
}
watch(() => [rubles.value, feeMode.value, individualPercent.value, globalPercent.value, pricingRevision.value] as const, ([value], _previous, onCleanup) => {
  pricing.value = null;
  pricingError.value = '';
  const price = rublesToKopecks(value);
  if (price === null || (!props.owner && feeValidation.value)) return;
  let active = true;
  const timer = setTimeout(async () => {
    try {
      const result = await api<ProductPricing>(`${apiRoot}/pricing`, { method: "POST", body: {
        price, ...(props.owner ? source ? { productId: source.id } : {} : { serviceMarkupPercentOverride: feeOverride.value }),
      } });
      if (active) acceptPricing(result);
    } catch (cause) {
      if (active) pricingError.value = serviceFeeError(cause);
    }
  }, 200);
  onCleanup(() => { active = false; clearTimeout(timer); });
});
// Refresh global-mode snapshots on opening, including a changed global setting.
if (!props.owner && feeMode.value === 'global') pricingRevision.value++;
const toast = useToast();
const busy = ref(false);
const error = ref("");
async function save() {
  if (busy.value) return;
  if (!props.owner && feeValidation.value) { error.value = feeValidation.value; return; }
  if (!props.owner && (globalPercent.value === null || settingsError.value)) {
    error.value = 'Не удалось загрузить общий процент. Обновите процент перед сохранением.'; return;
  }
  if (saleChanged.value && !saleConfirmed.value) {
    error.value = 'Подтвердите условия продажи и проверьте цену за новую единицу.'; return;
  }
  if (!props.owner && form.seasonalMode === 'AUTO' && !form.seasonTemplateId) {
    error.value = 'Выберите шаблон сезонности.'; return;
  }
  if (Object.keys(quantityError.value).length) {
    error.value = 'Проверьте настройки количества товара.';
    return;
  }
  const price = rublesToKopecks(rubles.value);
  if (price === null) {
    error.value =
      "Укажите положительную цену до 1 000 000 ₽, не более двух знаков после запятой";
    return;
  }
  const basePrice = settlementMode.value === "SHARED_MARKUP" ? rublesToKopecks(baseRubles.value) : null;
  if (!props.owner && settlementMode.value === "SHARED_MARKUP" && basePrice === null) {
    error.value = "Укажите корректную базовую цену для расчёта";
    return;
  }
  if (!form.categoryId) {
    error.value = "Выберите категорию";
    return;
  }
  busy.value = true;
  error.value = "";
  try {
    if (props.owner && !form.marketPointId) throw new Error('Выберите свою торговую точку');
    const ownerBody = {
      name: form.name.trim(), slug: form.slug, description: form.description.trim() || null,
      price, priceQty: form.priceQty, unit: form.unit, step: form.step, min: form.min, portionQty: form.portionQty,
      saleModel: form.saleModel, priceUnit: form.priceUnit, wholeLabel: variableWeight(form) ? form.wholeLabel : null,
      estimatedWeightGrams: form.estimatedWeightGrams, categoryId: form.categoryId, marketPointId: form.marketPointId,
      active: form.active, ...(saleChanged.value ? { saleChangeConfirmed: true } : {}),
    };
    const result = await api<AdminProduct>(
      source ? `${apiRoot}/${source.id}` : apiRoot,
      {
        method: source ? "PATCH" : "POST",
        body: props.owner ? ownerBody : {
          ...form,
          ...(!source || reviewConfirmed.value || feeOverride.value !== originalOverride.value
            ? { serviceMarkupPercentOverride: feeOverride.value } : {}),
          ...(saleChanged.value ? { saleChangeConfirmed: true } : {}),
          wholeLabel: variableWeight(form) ? form.wholeLabel : null,
          name: form.name.trim(),
          description: form.description.trim() || null,
          price,
          seasonalStartsAt: null,
          seasonalEndsAt: null,
          seasonTemplateId: form.seasonTemplateId || null,
          marketPointId: form.marketPointId || null,
          sourceUrl: form.sourceUrl.trim() || null,
          sourceCheckedAt: checkedDate.value ? `${checkedDate.value}T00:00:00.000Z` : null,
          settlementMode: settlementMode.value,
          basePrice,
        },
      },
    );
    if (!props.owner) {
      originalOverride.value = result.serviceMarkupPercentOverride;
      feeNeedsReview.value = result.serviceMarkupNeedsReview;
      reviewConfirmed.value = false;
      acceptPricing(result);
    }
    toast.add({
      title: source ? "Изменения сохранены" : "Товар создан",
      color: "success",
    });
    if (!source) await navigateTo(`${listPath}/${result.id}`);
    else emit("refresh");
  } catch (value) {
    error.value = serviceFeeError(value);
  } finally {
    busy.value = false;
  }
}
</script>
