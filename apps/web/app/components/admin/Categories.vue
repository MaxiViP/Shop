<template>
  <section class="space-y-4">
    <UButton icon="i-lucide-plus" @click="edit()">Добавить категорию</UButton>
    <p v-if="pending">Загрузка…</p>
    <UAlert v-else-if="error" color="error" :title="apiError(error)" />
    <p v-else-if="!categories?.length">Категорий пока нет</p>
    <div v-else class="grid md:grid-cols-2 gap-3">
      <UCard v-for="category in categories" :key="category.id">
        <div class="flex flex-wrap gap-2 items-center">
          <strong>{{ category.name }}</strong
          ><UBadge :color="category.active ? 'success' : 'neutral'">{{
            category.active ? "Опубликована" : "Скрыта"
          }}</UBadge>
        </div>
        <p class="text-sm text-muted my-2">
          {{ category.slug }} · Порядок: {{ category.sort }} · Товаров:
          {{ category._count?.products }} · Подкатегорий:
          {{ category._count?.children }}
        </p>
        <p class="text-sm mb-3">
          Родитель:
          {{
            categories.find((item) => item.id === category.parentId)?.name ??
            "Нет"
          }}
        </p>
        <div class="flex gap-2">
          <UButton variant="outline" @click="edit(category)"
            >Редактировать</UButton
          ><UButton
            color="error"
            variant="ghost"
            :disabled="busy"
            @click="
              selected = category;
              confirm = true;
            "
            >Удалить</UButton
          >
        </div>
      </UCard>
    </div>
    <UModal
      v-model:open="open"
      :title="form.id ? 'Редактировать категорию' : 'Новая категория'"
      :dismissible="!busy"
    >
      <template #body>
        <form class="space-y-4" @submit.prevent="save">
          <fieldset :disabled="busy" class="space-y-4">
            <UFormField label="Название" required
              ><UInput
                v-model="form.name"
                required
                maxlength="160"
                class="w-full"
                @update:model-value="generate"
            /></UFormField>
            <UFormField label="Slug" required
              ><UInput
                v-model="form.slug"
                required
                pattern="[a-z0-9]+(-[a-z0-9]+)*"
                maxlength="180"
                class="w-full"
                @input="manual = true"
            /></UFormField>
            <UFormField label="Родительская категория"
              ><USelect v-model="form.parentId" :items="parents" class="w-full"
            /></UFormField>
            <UFormField label="Порядок"
              ><UInput
                v-model.number="form.sort"
                type="number"
                required
                min="-1000000"
                max="1000000"
            /></UFormField>
            <USwitch v-model="form.active" label="Категория опубликована" />
            <UAlert v-if="formError" :title="formError" color="error" />
            <UButton type="submit" :loading="busy">Сохранить</UButton>
          </fieldset>
        </form>
      </template>
    </UModal>
    <AdminConfirm
      v-model:open="confirm"
      title="Удалить категорию навсегда?"
      description="Удаление доступно только для пустой категории без подкатегорий. Чтобы временно убрать категорию, скройте её."
      :busy="busy"
      @confirm="remove"
    />
  </section>
</template>

<script setup lang="ts">
import type { AdminCategory } from "~/types/admin";
const {
  data: categories,
  error,
  pending,
  refresh,
} = await useApi<AdminCategory[]>("/admin/categories");
const api = useApiClient();
const toast = useToast();
const busy = ref(false);
const open = ref(false);
const confirm = ref(false);
const selected = ref<AdminCategory>();
const manual = ref(false);
const formError = ref("");
const form = reactive({
  id: 0,
  name: "",
  slug: "",
  parentId: 0,
  active: true,
  sort: 0,
});
const parents = computed(() => [
  { label: "Нет", value: 0 },
  ...(categories.value ?? [])
    .filter((item) => item.id !== form.id)
    .map((item) => ({ label: item.name, value: item.id })),
]);
function edit(category?: AdminCategory) {
  Object.assign(
    form,
    category
      ? { ...category, parentId: category.parentId ?? 0 }
      : { id: 0, name: "", slug: "", parentId: 0, active: true, sort: 0 },
  );
  manual.value = Boolean(category);
  formError.value = "";
  open.value = true;
}
function generate() {
  if (!manual.value) form.slug = productSlug(form.name);
}
async function save() {
  if (busy.value) return;
  busy.value = true;
  formError.value = "";
  try {
    await api(form.id ? `/admin/categories/${form.id}` : "/admin/categories", {
      method: form.id ? "PATCH" : "POST",
      body: {
        name: form.name,
        slug: form.slug,
        parentId: form.parentId || null,
        active: form.active,
        sort: form.sort,
      },
    });
    open.value = false;
    toast.add({ title: "Категория сохранена", color: "success" });
    await refresh();
  } catch (value) {
    formError.value = apiError(value);
  } finally {
    busy.value = false;
  }
}
async function remove() {
  if (!selected.value || busy.value) return;
  busy.value = true;
  try {
    await api(`/admin/categories/${selected.value.id}`, { method: "DELETE" });
    confirm.value = false;
    toast.add({ title: "Категория удалена", color: "success" });
    await refresh();
  } catch (value) {
    toast.add({ title: apiError(value), color: "error" });
  } finally {
    busy.value = false;
  }
}
</script>
