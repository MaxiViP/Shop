<template>
  <div class="home">
    <UContainer>
      <section class="hero">
        <p class="hero__label">Москва</p>

        <h1 class="hero__title">Свежие продукты с рынка</h1>

        <p class="hero__text">Овощи, фрукты и зелень с доставкой на дом.</p>

        <UButton class="hero__action" to="/catalog" size="lg">
          В каталог
        </UButton>
      </section>

      <section class="home__section">
        <h2 class="home__title">Категории</h2>

        <CategoryList :items="categories" />
      </section>

      <section class="home__section">
        <div class="home__head">
          <h2 class="home__title">Продукты с рынка</h2>

          <NuxtLink to="/catalog">Смотреть всё →</NuxtLink>
        </div>

        <p v-if="status === 'pending'">Загружаем...</p>

        <UAlert
          v-else-if="error"
          title="Не удалось загрузить товары"
          color="error"
        />

        <ProductGrid v-else :items="products.items" />
      </section>
    </UContainer>
  </div>
</template>

<script setup lang="ts">
import type { Category } from "~/types/category";
import type { ProductListResponse } from "~/types/product";

const { data: categories } = await useApi<Category[]>("/categories", {
  default: () => [],
});

const {
  data: products,
  status,
  error,
} = await useApi<ProductListResponse>("/products", {
  query: { limit: 8 },
  default: () => ({ items: [], total: 0, page: 1, limit: 8, pages: 0 }),
});
</script>

<style scoped>
.home {
  min-width: 0;
  padding-bottom: var(--page-end);
}

.hero {
  max-width: 47.5rem;
  padding-block: clamp(3.5rem, 8vw, 6rem);
}

.hero__label {
  color: var(--ui-primary);
  font-weight: 600;
}

.hero__title {
  margin-top: 0.75rem;
  font-size: clamp(2.25rem, 1.55rem + 3.5vw, 4.5rem);
  font-weight: 700;
  line-height: 1;
}

.hero__text {
  max-width: 35rem;
  margin-block: 1.5rem 2rem;
  color: var(--ui-text-muted);
  font-size: clamp(1.0625rem, 0.95rem + 0.5vw, 1.25rem);
  line-height: 1.6;
}

.hero__action {
  width: 100%;
  min-height: var(--touch-target);
  justify-content: center;
}

.home__section {
  min-width: 0;
  margin-top: var(--section-gap);
}

.home__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin-bottom: 1.5rem;
}

.home__title {
  margin-bottom: 1.5rem;
  font-size: var(--section-title);
  font-weight: 600;
}

.home__head .home__title {
  margin-bottom: 0;
}

@media (min-width: 40rem) {
  .hero__action {
    width: auto;
  }
}
</style>
