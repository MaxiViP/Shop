<template>
  <CatalogView
    title="Каталог"
    description="Свежие продукты с рынка с доставкой по Москве."
    :categories="categories"
  />
</template>

<script setup lang="ts">
import { breadcrumbSchema } from "~/utils/seo";
import type { Category } from "~/types/category";

usePageSeo({
  title: "Продукты с рынка с доставкой по Москве — каталог KorzinaMarket",
  description: "Выбирайте продукты с рынка в каталоге KorzinaMarket. Категории, текущие цены и заказ с доставкой по Москве.",
});
useJsonLd(breadcrumbSchema([
  { label: "Главная", to: "/" }, { label: "Каталог", to: "/catalog" },
]));

const { data: categories } = await useApi<Category[]>("/categories", {
  default: () => [],
});
</script>

<style scoped></style>
