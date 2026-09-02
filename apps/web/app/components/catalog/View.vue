<template>
  <UContainer class="catalog">
    <header class="catalog__head">
      <h1 class="catalog__title">{{ title }}</h1>
      <p class="catalog__text">{{ description }}</p>
    </header>

    <CategoryList
      class="catalog__categories"
      :items="categories"
      :query="categoryQuery"
    />

    <div class="catalog__toolbar">
      <form
        class="catalog__search"
        role="search"
        @submit.prevent="submitSearch"
      >
        <UInput
          v-model="search"
          class="catalog__search-input"
          icon="i-lucide-search"
          placeholder="Поиск продуктов"
          aria-label="Поиск продуктов"
          maxlength="100"
          size="lg"
        />

        <UButton
          v-if="search"
          type="button"
          icon="i-lucide-x"
          variant="ghost"
          color="neutral"
          aria-label="Очистить поиск"
          @click="clearSearch"
        />

        <UButton type="submit" size="lg">Найти</UButton>
      </form>

      <USelect
        v-model="sort"
        class="catalog__sort"
        :items="productSortOptions"
        aria-label="Сортировка товаров"
        size="lg"
      />
    </div>

    <p v-if="status === 'pending'" class="catalog__state">Загружаем...</p>

    <UAlert
      v-else-if="error"
      title="Не удалось загрузить товары"
      color="error"
    />

    <template v-else>
      <p class="catalog__total">Найдено: {{ total }}</p>

      <ProductGrid v-if="items.length" :items="items" />

      <div v-else class="catalog__empty">
        <h2 class="catalog__empty-title">Ничего не найдено</h2>
        <UButton v-if="q" variant="soft" @click="clearSearch">
          Очистить поиск
        </UButton>
      </div>

      <div v-if="hasMore" class="catalog__more">
        <UButton
          size="lg"
          variant="soft"
          :loading="loadingMore"
          @click="showMore"
        >
          Показать ещё
        </UButton>
      </div>
    </template>
  </UContainer>
</template>

<script setup lang="ts">
import type { Category } from "~/types/category";
import { productSortOptions, useCatalog } from "~/composables/useCatalog";

const { title, description, category, categories } = defineProps<{
  title: string;
  description: string;
  category?: string;
  categories: Category[];
}>();

const toast = useToast();
const {
  search,
  q,
  sort,
  categoryQuery,
  items,
  total,
  status,
  error,
  loadingMore,
  hasMore,
  submitSearch,
  clearSearch,
  loadMore,
} = await useCatalog(category);

async function showMore() {
  try {
    await loadMore();
  } catch {
    toast.add({
      title: "Не удалось загрузить товары",
      description: "Попробуйте ещё раз",
      color: "error",
    });
  }
}
</script>

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

.catalog__toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1.5rem;
}

.catalog__search {
  display: flex;
  flex: 1;
  gap: 0.5rem;
  max-width: 680px;
}

.catalog__search-input {
  flex: 1;
}

.catalog__sort {
  width: 220px;
}

.catalog__state,
.catalog__total {
  color: var(--ui-text-muted);
}

.catalog__total {
  margin-bottom: 1rem;
}

.catalog__empty {
  display: grid;
  justify-items: start;
  gap: 1rem;
  padding-block: 3rem;
}

.catalog__empty-title {
  font-size: 1.5rem;
  font-weight: 600;
}

.catalog__more {
  display: flex;
  justify-content: center;
  margin-top: 2rem;
}

@media (max-width: 640px) {
  .catalog__toolbar {
    align-items: stretch;
    flex-direction: column;
  }

  .catalog__sort {
    width: 100%;
  }
}
</style>
