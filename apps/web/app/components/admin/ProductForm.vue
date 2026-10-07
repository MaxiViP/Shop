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
          <UFormField label="Достоверность цены" help="Статус относится к цене продавца; сервис добавляется автоматически.">
            <USelect v-model="form.priceStatus" :items="priceStatusItems" class="w-full" />
          </UFormField>
          <UFormField :label="`Цена за количество (${quantityLabel})`"
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
          <UFormField :label="`Быстро добавить (${quantityLabel})`" :error="quantityError.portionQty" help="Столько товара добавляется одним нажатием + в каталоге."
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
        <dl v-if="pricing" class="mt-4 grid grid-cols-2 gap-2 text-sm max-w-md" aria-live="polite">
          <dt>Цена продавца</dt><dd>{{ money(pricing.sellerPrice) }}</dd>
          <dt>Сервис {{ pricing.serviceMarkupPercent }}%</dt><dd>{{ money(pricing.serviceMarkup) }}</dd>
          <dt>Цена покупателя</dt><dd>{{ money(pricing.customerPrice) }}</dd>
        </dl>
        <p v-else-if="rublesToKopecks(rubles) !== null" class="mt-4 text-sm text-muted" aria-live="polite">{{ pricingError ? 'Не удалось рассчитать цену покупателя.' : 'Цена покупателя рассчитывается…' }}</p>
        <div v-if="preview" class="mt-4 space-y-1 text-sm text-muted" aria-live="polite">
          <h3 class="font-semibold text-default">Настройки количества</h3>
          <p>Минимум: {{ qtyText(form.unit, form.min) }} · Шаг: {{ qtyText(form.unit, form.step) }} · Быстро добавить: {{ qtyText(form.unit, form.portionQty) }}</p>
          <p>Каталог: {{ preview.quick }}</p>
          <p>Изменение количества: {{ preview.manual }}</p>
        </div>
      </UCard>
      <UCard>
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
          <UFormField label="Проверено">
            <UInput v-model="checkedDate" type="date" class="w-full" />
          </UFormField>
          <UFormField label="Источник цены продавца" class="sm:col-span-2">
            <UInput v-model="form.sourceUrl" type="url" maxlength="2000" placeholder="https://…" class="w-full" />
            <a v-if="source?.sourceUrl" :href="source.sourceUrl" target="_blank" rel="noopener noreferrer" class="text-sm text-primary underline">Открыть источник</a>
          </UFormField>
        </div>
      </UCard>
      <UCard>
        <template #header><h2 class="font-semibold">Публикация</h2></template>
        <div class="flex flex-wrap gap-6 items-center">
          <USwitch v-model="form.active" label="Товар опубликован" />
          <UFormField label="Порядок"
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
        ><UButton to="/admin/products" color="neutral" variant="outline"
          >К списку</UButton
        >
      </div>
    </fieldset>
  </form>
  <UCard class="mt-6">
    <AdminImages
      v-if="product"
      :product-id="product.id"
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
import { MAX_QTY, manualQuantity, quantityErrors, quickQuantity } from "~/utils/assembly";
import { qtyText } from "~/utils/qty";
const props = defineProps<{
  product?: AdminProduct;
  categories: AdminCategory[];
}>();
const emit = defineEmits<{ refresh: [] }>();
const source = props.product;
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
  active: source?.active ?? true,
  sort: source?.sort ?? 0,
});
const rubles = ref(source ? kopecksToRubles(source.price) : "");
const checkedDate = ref(source?.sourceCheckedAt?.slice(0, 10) ?? "");
const pricing = ref<ProductPricing | null>(source ?? null);
const pricingError = ref(false);
const { data: marketPoints } = await useApi<MarketPoint[]>("/admin/market-map/points");
const pointItems = computed(() => [
  { label: "Без торговой точки", value: 0 },
  ...(marketPoints.value ?? []).filter(point => point.kind !== "ENTRY").map(point => ({ label: point.name, value: point.id })),
]);
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
const quantityError = computed(() => quantityErrors(form));
const preview = computed(() => {
  if (Object.keys(quantityError.value).length) return null;
  const quick: number[] = [];
  const manual = [form.min];
  for (let i = 0; i < 3; i++) {
    const next = quickQuantity(quick.at(-1), form);
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
watch(rubles, (value, _previous, onCleanup) => {
  pricing.value = null;
  pricingError.value = false;
  const price = rublesToKopecks(value);
  if (price === null) return;
  let active = true;
  const timer = setTimeout(async () => {
    try {
      const result = await api<ProductPricing>("/admin/products/pricing", { method: "POST", body: { price } });
      if (active) pricing.value = result;
    } catch {
      if (active) pricingError.value = true;
    }
  }, 200);
  onCleanup(() => { active = false; clearTimeout(timer); });
});
const toast = useToast();
const busy = ref(false);
const error = ref("");
async function save() {
  if (busy.value) return;
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
  if (settlementMode.value === "SHARED_MARKUP" && basePrice === null) {
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
    const result = await api<AdminProduct>(
      source ? `/admin/products/${source.id}` : "/admin/products",
      {
        method: source ? "PATCH" : "POST",
        body: {
          ...form,
          name: form.name.trim(),
          description: form.description.trim() || null,
          price,
          marketPointId: form.marketPointId || null,
          sourceUrl: form.sourceUrl.trim() || null,
          sourceCheckedAt: checkedDate.value ? `${checkedDate.value}T00:00:00.000Z` : null,
          settlementMode: settlementMode.value,
          basePrice,
        },
      },
    );
    toast.add({
      title: source ? "Изменения сохранены" : "Товар создан",
      color: "success",
    });
    if (!source) await navigateTo(`/admin/products/${result.id}`);
    else emit("refresh");
  } catch (value) {
    error.value = apiError(value);
  } finally {
    busy.value = false;
  }
}
</script>
