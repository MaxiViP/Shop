<template>
  <UContainer class="catalog">
    <h1 class="catalog__title">Каталог</h1>

    <CategoryList class="catalog__categories" :items="categories" />

    <ProductGrid :items="products" />
  </UContainer>
</template>

<script setup lang="ts">
import type { Category } from "~/types/category";
import type { Product } from "~/types/product";

useSeoMeta({
  title: "Каталог",
  description: "Свежие овощи, фрукты и зелень с рынка.",
});

const { data: categories } = await useApi<Category[]>("/categories", {
  default: () => [],
});

const { data: products } = await useApi<Product[]>("/products", {
  default: () => [],
});
</script>

<style scoped>
.catalog {
  padding-block: 3rem;
}

.catalog__title {
  margin-bottom: 1.5rem;
  font-size: 2.5rem;
  font-weight: 700;
}

.catalog__categories {
  margin-bottom: 2rem;
}
</style>
