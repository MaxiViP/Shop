<template>
  <div class="space-y-5">
    <div class="flex flex-wrap items-center gap-3">
      <h2 class="text-2xl font-semibold mr-auto">Товары</h2>
      <UButton to="/admin/products/new" icon="i-lucide-plus"
        >Добавить товар</UButton
      >
    </div>
    <div class="flex gap-2">
      <UButton
        :variant="section === 'products' ? 'solid' : 'outline'"
        @click="section = 'products'"
        >Товары</UButton
      ><UButton
        :variant="section === 'categories' ? 'solid' : 'outline'"
        @click="section = 'categories'"
        >Категории</UButton
      >
    </div>
    <AdminCategories v-if="section === 'categories'" />
    <section v-else class="space-y-4">
      <form class="grid min-w-0 gap-3 items-end sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto]" @submit.prevent="apply">
        <UFormField label="Поиск"
          ><UInput
            v-model="search"
            placeholder="Название или slug"
            maxlength="160"
        /></UFormField>
        <UFormField label="Категория"
          ><USelect v-model="category" :items="categoryItems"
        /></UFormField>
        <UFormField label="Статус"
          ><USelect
            v-model="active"
            :items="[
              { label: 'Все', value: 'all' },
              { label: 'Опубликованные', value: 'true' },
              { label: 'Скрытые', value: 'false' },
            ]"
        /></UFormField>
        <UButton type="submit" :loading="pending">Найти</UButton>
      </form>
      <p v-if="pending" role="status">Загрузка…</p>
      <UAlert v-else-if="error" color="error" :title="apiError(error)" />
      <p v-else-if="!data?.items.length">Товары не найдены</p>
      <div v-else class="overflow-x-auto border border-default rounded-lg">
        <table class="w-full text-sm min-w-[780px]">
          <thead class="bg-elevated text-left">
            <tr>
              <th class="p-3">Фото</th>
              <th>Название</th>
              <th>Категория</th>
              <th>Цена / ед.</th>
              <th>Статус</th>
              <th>Порядок</th>
              <th class="p-3">Действия</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="product in data.items"
              :key="product.id"
              class="border-t border-default"
            >
              <td class="p-3">
                <img
                  v-if="product.images[0]"
                  :src="asset(product.images[0].url)"
                  :alt="product.images[0].alt ?? ''"
                  class="w-12 h-12 object-cover rounded"
                ><span v-else>—</span>
              </td>
              <td class="pr-3">
                <NuxtLink
                  :to="`/admin/products/${product.id}`"
                  class="font-medium text-primary"
                  >{{ product.name }}</NuxtLink
                >
              </td>
              <td class="pr-3">{{ product.category.name }}</td>
              <td class="pr-3 whitespace-nowrap">
                {{ money(product.price) }} / {{ product.priceQty }}
                {{ labels[product.unit] }}
              </td>
              <td class="pr-3">
                <UBadge :color="product.active ? 'success' : 'neutral'">{{
                  product.active ? "Опубликован" : "Скрыт"
                }}</UBadge>
              </td>
              <td>{{ product.sort }}</td>
              <td class="p-3">
                <div class="flex flex-wrap gap-2">
                  <UButton
                    :to="`/admin/products/${product.id}`"
                    size="xs"
                    variant="outline"
                    >Редактировать</UButton
                  ><UButton
                    v-if="product.active"
                    size="xs"
                    variant="ghost"
                    :disabled="busy"
                    @click="hide(product)"
                    >Скрыть</UButton
                  ><UButton
                    size="xs"
                    color="error"
                    variant="ghost"
                    :disabled="busy"
                    @click="
                      selected = product;
                      confirm = true;
                    "
                    >Удалить</UButton
                  >
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="data" class="flex flex-wrap items-center gap-3">
        <UButton
          :disabled="query.page <= 1 || pending"
          variant="outline"
          @click="query.page--"
          >Назад</UButton
        ><span
          >{{ query.page }} / {{ Math.max(1, data.pages) }} · Всего
          {{ data.total }}</span
        ><UButton
          :disabled="query.page >= data.pages || pending"
          variant="outline"
          @click="query.page++"
          >Далее</UButton
        >
      </div>
    </section>
    <AdminConfirm
      v-model:open="confirm"
      title="Удалить товар навсегда?"
      :description="`Товар «${selected?.name ?? ''}» будет удалён из каталога. Снимки в истории заказов сохранятся. Это действие нельзя отменить.`"
      :busy="busy"
      @confirm="remove"
    />
  </div>
</template>

<script setup lang="ts">
import type { AdminProduct, AdminCategory, AdminPage } from "~/types/admin";
definePageMeta({ middleware: "admin", layout: "admin" });
const section = ref("products");
const search = ref("");
const category = ref(0);
const active = ref("all");
const query = reactive({
  page: 1,
  limit: 20,
  search: "",
  category: undefined as number | undefined,
  active: undefined as string | undefined,
});
const { data, pending, error, refresh } = await useApi<AdminPage<AdminProduct>>(
  "/admin/products",
  { query },
);
const { data: categories, refresh: refreshCategories } =
  await useApi<AdminCategory[]>("/admin/categories");
watch(section, async (value) => {
  if (value === "products") {
    await refreshCategories();
    await refresh();
  }
});
const categoryItems = computed(() => [
  { label: "Все", value: 0 },
  ...(categories.value ?? []).map((item) => ({
    label: item.name,
    value: item.id,
  })),
]);
function apply() {
  Object.assign(query, {
    page: 1,
    search: search.value,
    category: category.value || undefined,
    active: active.value === "all" ? undefined : active.value,
  });
}
const labels = { GRAM: "г", PIECE: "шт.", BUNCH: "пуч.", PACK: "уп." };
const api = useApiClient();
const toast = useToast();
const asset = useAsset();
const busy = ref(false);
const confirm = ref(false);
const selected = ref<AdminProduct>();
async function hide(product: AdminProduct) {
  if (busy.value) return;
  busy.value = true;
  try {
    await api(`/admin/products/${product.id}`, {
      method: "PATCH",
      body: { active: false },
    });
    toast.add({ title: "Товар скрыт", color: "success" });
    await refresh();
  } catch (value) {
    toast.add({ title: apiError(value), color: "error" });
  } finally {
    busy.value = false;
  }
}
async function remove() {
  if (!selected.value || busy.value) return;
  busy.value = true;
  try {
    await api(`/admin/products/${selected.value.id}`, { method: "DELETE" });
    confirm.value = false;
    toast.add({ title: "Товар удалён", color: "success" });
    await refresh();
  } catch (value) {
    toast.add({ title: apiError(value), color: "error" });
  } finally {
    busy.value = false;
  }
}
</script>
