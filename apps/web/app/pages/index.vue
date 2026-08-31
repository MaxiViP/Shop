<script setup lang="ts">
import type { Category } from '~/types/category'
import type { Product } from '~/types/product'

const { data: categories } = await useApi<Category[]>('/categories', {
  default: () => [],
})

const {
  data: products,
  status,
  error,
} = await useApi<Product[]>('/products', {
  default: () => [],
})
</script>

<template>
  <div class="home">
    <UContainer>
      <section class="hero">
        <p class="hero__label">
          Москва
        </p>

        <h1 class="hero__title">
          Свежие продукты с рынка
        </h1>

        <p class="hero__text">
          Овощи, фрукты и зелень с доставкой на дом.
        </p>

        <UButton
          to="/catalog"
          size="lg"
        >
          В каталог
        </UButton>
      </section>

      <section class="home__section">
        <h2 class="home__title">
          Категории
        </h2>

        <CategoryList :items="categories" />
      </section>

      <section class="home__section">
        <div class="home__head">
          <h2 class="home__title">
            Популярное
          </h2>

          <NuxtLink to="/catalog">
            Смотреть всё →
          </NuxtLink>
        </div>

        <p v-if="status === 'pending'">
          Загружаем...
        </p>

        <UAlert
          v-else-if="error"
          title="Не удалось загрузить товары"
          color="error"
        />

        <ProductGrid
          v-else
          :items="products"
        />
      </section>
    </UContainer>
  </div>
</template>

<style scoped>
.home {
  padding-bottom: 5rem;
}

.hero {
  max-width: 760px;
  padding-block: 6rem;
}

.hero__label {
  color: var(--ui-primary);
  font-weight: 600;
}

.hero__title {
  margin-top: 0.75rem;
  font-size: clamp(2.5rem, 7vw, 4.5rem);
  font-weight: 700;
  line-height: 1;
}

.hero__text {
  max-width: 560px;
  margin-block: 1.5rem 2rem;
  color: var(--ui-text-muted);
  font-size: 1.25rem;
}

.home__section {
  margin-top: 4rem;
}

.home__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1.5rem;
}

.home__title {
  margin-bottom: 1.5rem;
  font-size: 1.75rem;
  font-weight: 600;
}

.home__head .home__title {
  margin-bottom: 0;
}
</style>
