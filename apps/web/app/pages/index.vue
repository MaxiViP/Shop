<template>
  <div class="home">
    <UContainer>
      <section class="hero">
        <div class="hero__content">
          <p class="hero__label">Москва</p>

          <h1 class="hero__title">Свежие продукты и товары с рынка</h1>

          <p class="hero__text">Овощи, Фрукты, Ягоды, Зелень и многое другое с доставкой на дом.</p>

          <UButton class="hero__action" to="/catalog" size="lg">
            В каталог
          </UButton>
        </div>
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
  position: relative;
  isolation: isolate;
  display: flex;
  width: 100%;
  min-width: 0;
  min-height: clamp(24rem, 80vw, 30rem);
  align-items: center;
  margin-top: var(--page-start);
  padding: clamp(1rem, 4vw, 4rem);
  overflow: hidden;
  border-radius: 1rem;
  background-color: #050f1e;
  background-image: url('/images/market-hero.webp');
  background-size: cover;
  background-position: center 45%;
  background-repeat: no-repeat;
}

.hero::before {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, rgba(5, 15, 30, 0.88) 0%, rgba(5, 15, 30, 0.76) 55%, rgba(5, 15, 30, 0.64) 100%);
  pointer-events: none;
}

.hero__content {
  position: relative;
  z-index: 1;
  width: 100%;
  min-width: 0;
  max-width: 40rem;
}

.hero__label {
  color: var(--ui-primary);
  font-weight: 600;
}

.hero__title {
  max-width: 40rem;
  color: #fff;
  overflow-wrap: anywhere;
  margin-top: 0.75rem;
  font-size: clamp(2rem, 1.25rem + 3.5vw, 4.5rem);
  font-weight: 700;
  line-height: 1.12;
}

.hero__text {
  max-width: 35rem;
  margin-block: 1rem 1.5rem;
  color: rgba(255, 255, 255, 0.9);
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

.home__head > a {
  display: inline-flex;
  align-items: center;
  min-height: var(--touch-target);
}

@media (min-width: 40rem) {
  .hero__action {
    width: auto;
  }
}
@media (min-width: 48rem) {
  .hero {
    min-height: clamp(22rem, 42vw, 36rem);
    background-position: center center;
  }

  .hero::before {
    background: linear-gradient(90deg, rgba(5, 15, 30, 0.86) 0%, rgba(5, 15, 30, 0.68) 55%, rgba(5, 15, 30, 0.28) 100%);
  }
}
</style>
