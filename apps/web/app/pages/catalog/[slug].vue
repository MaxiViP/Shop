<template>
  <CatalogView
    :key="slug"
    :title="category!.name"
    :description="category!.description || metadata.description"
    :category="slug"
    :categories="categories"
  />
</template>

<script setup lang="ts">
import { breadcrumbSchema, categorySeo } from "~/utils/seo";
import type { Category } from "~/types/category";

definePageMeta({
  key: (route) => String(route.params.slug),
});

const route = useRoute();
const slug = computed(() => String(route.params.slug));
const { data: categories, error: categoriesError } = await useApi<Category[]>("/categories", {
  default: () => [],
});
const category = computed(() =>
  categories.value.find((item) => item.slug === slug.value),
);

if (categoriesError.value) {
  throw createError({ statusCode: 503, statusMessage: "Каталог временно недоступен" });
}
if (!category.value) {
  throw createError({
    statusCode: 404,
    statusMessage: "Категория не найдена",
  });
}

const metadata = computed(() => categorySeo(category.value!));
usePageSeo(() => ({ ...metadata.value, image: category.value?.image || undefined, indexable: category.value?.indexable }));
useJsonLd(() => breadcrumbSchema([
  { label: "Главная", to: "/" },
  { label: "Каталог", to: "/catalog" },
  { label: category.value!.name, to: '/catalog/' + encodeURIComponent(slug.value) },
]));
</script>

<style scoped></style>
