<template>
  <CatalogView
    :key="slug"
    :title="category!.name"
    description="Свежие продукты с рынка с доставкой по Москве."
    :category="slug"
    :categories="categories"
  />
</template>

<script setup lang="ts">
import type { Category } from "~/types/category";

definePageMeta({
  key: (route) => String(route.params.slug),
});

const route = useRoute();
const slug = computed(() => String(route.params.slug));
const { data: categories } = await useApi<Category[]>("/categories", {
  default: () => [],
});
const category = computed(() =>
  categories.value.find((item) => item.slug === slug.value),
);

if (!category.value) {
  throw createError({
    statusCode: 404,
    statusMessage: "Категория не найдена",
  });
}

useSeoMeta({
  title: () => category.value?.name ?? "Каталог",
  description: () =>
    `${category.value?.name ?? "Продукты"} с доставкой по Москве.`,
});
</script>

<style scoped></style>
