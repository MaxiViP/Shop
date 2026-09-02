<template>
  <CatalogView
    title="Каталог"
    description="Свежие продукты с рынка с доставкой по Москве."
    :categories="categories"
  />
</template>

<script setup lang="ts">
import type { Category } from "~/types/category";

useSeoMeta({
  title: "Каталог",
  description: "Свежие овощи, фрукты и зелень с рынка.",
});

const { data: categories } = await useApi<Category[]>("/categories", {
  default: () => [],
});
</script>

<style scoped></style>
