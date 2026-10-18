<template>
  <UContainer class="py-6 space-y-4">
    <AppBackButton fallback="/staff/products" label="К своим товарам" />
    <h1 class="text-2xl font-semibold">Редактировать свой товар</h1>
    <UAlert v-if="error || categoryError" color="error" title="Товар недоступен или не принадлежит вашей точке" />
    <AdminProductForm v-else-if="product && categories" :key="product.id" owner :product="product" :categories="categories" @refresh="refresh" />
  </UContainer>
</template>

<script setup lang="ts">
import type { AdminCategory, AdminProduct } from '~/types/admin';
definePageMeta({ middleware: 'owner' });
const route = useRoute();
const { data: product, error, refresh } = await useApi<AdminProduct>(`/owner/products/${route.params.id}`);
const { data: categories, error: categoryError } = await useApi<AdminCategory[]>('/owner/categories');
</script>
