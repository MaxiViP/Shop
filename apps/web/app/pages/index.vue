<template>
  <div class="home">
    <UContainer>
      <HomeHeroCarousel />

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
      <section class="home__section" aria-labelledby="market-about">
        <h2 id="market-about" class="home__title">Продукты с рынка с доставкой по Москве</h2>
        <p class="home__text">{{ site.about }}</p>
        <p class="home__text">{{ site.delivery.priorityText }}</p>
        <NuxtLink class="home__delivery" to="/delivery">Условия доставки</NuxtLink>
      </section>
    </UContainer>
  </div>
</template>

<script setup lang="ts">
import HomeHeroCarousel from "~/components/home/HeroCarousel.vue";
import { site } from "~~/shared/utils/site";
import { storeSchema } from "~/utils/seo";
import type { Category } from "~/types/category";
import type { ProductListResponse } from "~/types/product";

usePageSeo({ title: site.title, description: site.description });
useJsonLd(storeSchema());


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

.home__text { margin-bottom: 0.75rem; line-height: 1.65; }
.home__delivery { display: inline-flex; min-height: 44px; align-items: center; color: var(--ui-primary); }
</style>
