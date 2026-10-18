<template>
  <UContainer class="py-6 space-y-4">
    <AppBackButton fallback="/staff/products" label="К своим товарам" />
    <h1 class="text-2xl font-semibold">Добавить товар своей точки</h1>
    <UAlert v-if="error" color="error" :title="apiError(error)" />
    <AdminProductForm v-else-if="categories" owner :categories="categories" />
  </UContainer>
</template>

<script setup lang="ts">
import type { AdminCategory } from '~/types/admin';
definePageMeta({ middleware: 'owner' });
const { data: categories, error } = await useApi<AdminCategory[]>('/owner/categories');
</script>
