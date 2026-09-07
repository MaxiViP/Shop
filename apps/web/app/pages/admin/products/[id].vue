<template>
  <div class="space-y-4">
    <AppBackButton fallback="/admin/products" label="К товарам" />
    <h2 class="text-2xl font-semibold">Редактировать товар</h2>
    <UAlert
      v-if="error || categoryError"
      color="error"
      title="Не удалось загрузить товар или категории"
    />
    <AdminProductForm
      v-else-if="product && categories"
      :product="product"
      :categories="categories"
      @refresh="refresh"
    />
    <p v-else>Загрузка…</p>
  </div>
</template>

<script setup lang="ts">
import type { AdminProduct, AdminCategory } from "~/types/admin";
definePageMeta({ middleware: "admin", layout: "admin" });
const route = useRoute();
const {
  data: product,
  error,
  refresh,
} = await useApi<AdminProduct>(`/admin/products/${route.params.id}`);
const { data: categories, error: categoryError } =
  await useApi<AdminCategory[]>("/admin/categories");
</script>
