<template>
  <form class="space-y-6" @submit.prevent="save">
    <fieldset :disabled="busy" class="space-y-6">
      <UCard>
        <template #header><h2 class="font-semibold">Основное</h2></template>
        <div class="grid sm:grid-cols-2 gap-4">
          <UFormField label="Название товара" required
            ><UInput
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
          <UFormField label="Цена, ₽" required
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
          <UFormField :label="`Цена за количество (${quantityLabel})`"
            ><UInput
              v-model.number="form.priceQty"
              type="number"
              min="1"
              max="1000000"
              step="1"
              required
              class="w-full"
          /></UFormField>
          <UFormField :label="`Минимальный заказ (${quantityLabel})`"
            ><UInput
              v-model.number="form.min"
              type="number"
              min="1"
              max="1000000"
              step="1"
              required
              class="w-full"
          /></UFormField>
          <UFormField :label="`Шаг заказа (${quantityLabel})`"
            ><UInput
              v-model.number="form.step"
              type="number"
              min="1"
              max="1000000"
              step="1"
              required
              class="w-full"
          /></UFormField>
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
      <div class="flex gap-3">
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
import type { AdminProduct, AdminCategory } from "~/types/admin";
import type { Unit } from "~/types/product";
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
  priceQty: source?.priceQty ?? 1,
  unit: source?.unit ?? ("PIECE" as Unit),
  min: source?.min ?? 1,
  step: source?.step ?? 1,
  active: source?.active ?? true,
  sort: source?.sort ?? 0,
});
const rubles = ref(source ? kopecksToRubles(source.price) : "");
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
const toast = useToast();
const busy = ref(false);
const error = ref("");
async function save() {
  if (busy.value) return;
  const price = rublesToKopecks(rubles.value);
  if (price === null) {
    error.value =
      "Укажите положительную цену до 1 000 000 ₽, не более двух знаков после запятой";
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
