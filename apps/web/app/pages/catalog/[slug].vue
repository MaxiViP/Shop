<script setup lang="ts">
import type { Category } from '~/types/category'
import type { Product } from '~/types/product'

const route = useRoute()
const slug = String(route.params.slug)

const { data: categories } = await useApi<Category[]>('/categories', {
  default: () => [],
})

const category = computed(() =>
  categories.value.find(item => item.slug === slug),
)

if (!category.value) {
  throw createError({
    statusCode: 404,
    statusMessage: 'Категория не найдена',
  })
}

const {
  data: products,
  status,
  error,
} = await useApi<Product[]>('/products', {
  query: { category: slug },
  default: () => [],
})

useSeoMeta({
  title: () => category.value?.name ?? 'Каталог',
  description: () =>
    `${category.value?.name ?? 'Продукты'} с доставкой по Москве.`,
})
</script>

<template>
  <UContainer class="catalog">
    <header class="catalog__head">
      <h1 class="catalog__title">
        {{ category?.name }}
      </h1>

      <p class="catalog__text">
        Свежие продукты с рынка с доставкой по Москве.
      </p>
    </header>

    <CategoryList
      class="catalog__categories"
      :items="categories"
    />

    <p v-if="status === 'pending'">
      Загружаем...
    </p>

    <UAlert
      v-else-if="error"
      title="Не удалось загрузить товары"
      color="error"
    />

    <ProductGrid
      v-else-if="products.length"
      :items="products"
    />

    <p
      v-else
      class="catalog__empty"
    >
      В этой категории пока нет товаров.
    </p>
  </UContainer>
</template>

<style scoped>
.catalog {
  padding-block: 3rem 5rem;
}

.catalog__head {
  margin-bottom: 2rem;
}

.catalog__title {
  font-size: 2.5rem;
  font-weight: 700;
}

.catalog__text {
  margin-top: 0.5rem;
  color: var(--ui-text-muted);
}

.catalog__categories {
  margin-bottom: 2rem;
}

.catalog__empty {
  color: var(--ui-text-muted);
}
</style>
