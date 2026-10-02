<template>
  <div class="home">
    <UContainer>
      <HomeHeroCarousel />

      <section class="home__feature" aria-labelledby="market-photo-choice">
        <div class="home__feature-head">
          <span class="home__feature-icon" aria-hidden="true"><UIcon name="i-lucide-store" /></span>
          <div>
            <h2 id="market-photo-choice" class="home__feature-title">Выбирайте продукты прямо с прилавка</h2>
            <p class="home__feature-text">Не уверены, какой товар взять? Продавец отправит актуальное фото прилавка прямо из рынка. Откройте снимок, отметьте понравившийся продукт и отправьте отметку продавцу — он увидит, что именно вы выбрали.</p>
          </div>
        </div>
        <ol class="home__feature-flow" aria-label="Как выбрать продукт с прилавка">
          <li><UIcon name="i-lucide-camera" class="home__feature-step-icon" aria-hidden="true" /><span>Продавец фотографирует</span><UIcon name="i-lucide-arrow-right" class="home__feature-arrow" aria-hidden="true" /></li>
          <li><UIcon name="i-lucide-pencil" class="home__feature-step-icon" aria-hidden="true" /><span>Вы отмечаете</span><UIcon name="i-lucide-arrow-right" class="home__feature-arrow" aria-hidden="true" /></li>
          <li><UIcon name="i-lucide-shopping-basket" class="home__feature-step-icon" aria-hidden="true" /><span>Продавец кладёт выбранный товар в заказ</span></li>
        </ol>
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
.home__feature {
  display: grid;
  gap: 1rem;
  margin-top: var(--section-gap);
  padding: clamp(1rem, 2vw, 1.5rem);
  border: 1px solid color-mix(in srgb, var(--ui-primary) 45%, var(--ui-border));
  border-radius: 1.25rem;
  background: linear-gradient(135deg, color-mix(in srgb, var(--ui-primary) 9%, var(--ui-bg)), var(--ui-bg-elevated));
}
.home__feature-head { display: flex; align-items: start; gap: 0.9rem; min-width: 0; }
.home__feature-icon { display: grid; place-items: center; flex: none; width: 2.5rem; height: 2.5rem; border-radius: 0.75rem; color: var(--ui-primary); background: color-mix(in srgb, var(--ui-primary) 16%, var(--ui-bg)); font-size: 1.25rem; }
.home__feature-title { font-size: clamp(1.15rem, 2.5vw, 1.5rem); font-weight: 700; line-height: 1.25; }
.home__feature-text { max-width: 74ch; margin-top: 0.45rem; color: var(--ui-text-muted); line-height: 1.55; }
.home__feature-flow { display: grid; gap: 0.5rem; list-style: none; margin: 0; padding: 0; }
.home__feature-flow li { display: flex; align-items: center; gap: 0.65rem; min-width: 0; padding: 0.6rem 0.75rem; border: 1px solid var(--ui-border); border-radius: 0.75rem; background: color-mix(in srgb, var(--ui-primary) 4%, var(--ui-bg)); font-size: 0.875rem; }
.home__feature-step-icon { flex: none; color: var(--ui-primary); font-size: 1.1rem; }
.home__feature-arrow { flex: none; margin-left: auto; color: var(--ui-primary); }
@media (min-width: 48rem) {
  .home__feature-flow { grid-template-columns: repeat(3, minmax(0, 1fr)); }
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
