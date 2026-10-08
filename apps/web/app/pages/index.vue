<template>
  <div class="home" :data-loaded-count="items.length">
    <UContainer>
      <HomeHeroCarousel />

      <section class="home__section home__section--categories">
        <CategoryList v-model:sort="sort" :items="categories" :query="sortQuery" active="" />
      </section>

      <section class="home__section">
        <div class="home__head">
          <h2 class="home__title">Продукты с рынка</h2>

          <NuxtLink to="/catalog">Смотреть всё →</NuxtLink>
        </div>

        <ProductSkeleton v-if="status === 'pending'" />

        <UAlert
          v-else-if="error && !items.length"
          title="Не удалось загрузить товары"
          color="error"
        >
          <template #actions><UButton type="button" variant="soft" @click="retry">Повторить</UButton></template>
        </UAlert>
        <template v-else>
          <ProductGrid :items="items" :windowed="items.length > 120" />
          <ProductMore v-if="items.length || hasMore" :has-more="hasMore" :loading="loadingMore" :error="!!error" :stale="stale" @load="loadMore" @retry="retry" />
          <p v-else class="home__empty">Товары скоро появятся</p>
        </template>
      </section>
    </UContainer>
  </div>
</template>

<script setup lang="ts">
import HomeHeroCarousel from "~/components/home/HeroCarousel.vue";
import { site } from "~~/shared/utils/site";
import { storeSchema } from "~/utils/seo";
import type { Category } from "~/types/category";

usePageSeo({ title: site.title, description: site.description });
useJsonLd(storeSchema());


const { data: categories } = await useApi<Category[]>("/categories", {
  default: () => [],
});

const { sort, sortQuery } = useProductSort();
const { items, status, error, stale, hasMore, loadingMore, loadMore, retry } =
  await useProductFeed(() => ({ feed: sort.value === 'recommended' ? 'home' : 'catalog', sort: sort.value, limit: 24 }), 'home-products');
</script>

<style scoped>
:global(html:has(.home)), :global(body:has(.home)), :global(#__nuxt:has(.home)) { min-width: 0; }
.home {
  min-width: 0;
  padding-bottom: var(--page-end);
}

.home__section {
  min-width: 0;
  margin-top: var(--section-gap);
}
.home__section--categories {
  margin-top: clamp(1rem, 2vw, 1.5rem);
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

.home__empty { color: var(--ui-text-muted); }
</style>
