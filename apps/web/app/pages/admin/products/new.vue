<template>
  <div class="space-y-4">
    <AppBackButton fallback="/admin/products" label="К товарам" />
    <h2 class="text-2xl font-semibold">Добавить товар</h2>
    <UAlert
      v-if="error"
      color="error"
      title="Не удалось загрузить категории"
    /><AdminProductForm v-else-if="categories" :categories="categories" />
  </div>
</template>

<script setup lang="ts">
import type { AdminCategory } from "~/types/admin";
definePageMeta({ middleware: "admin", layout: "admin" });
const { data: categories, error } =
  await useApi<AdminCategory[]>("/admin/categories");
</script>
