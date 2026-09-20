<template>
  <UContainer class="catalog">
    <AppBreadcrumbs :items="breadcrumbs" />
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
          class="catalog__clear"
          type="button"
          icon="i-lucide-x"
          variant="ghost"
          color="neutral"
          aria-label="Очистить поиск"
          @click="clearSearch"
        />

        <UButton class="catalog__submit" type="submit" size="lg">
          Найти
        </UButton>
      </form>

      <div class="catalog__sort" role="group" aria-label="Сортировка товаров">
        <button
          v-for="option in productSortOptions"
          :key="option.value"
          type="button"
          class="catalog__sort-option"
          :aria-pressed="sort === option.value"
          :aria-label="option.label"
          :title="option.label"
          @click="sort = option.value"
        >
          <UIcon :name="option.icon" class="catalog__sort-icon" aria-hidden="true" />
          <span class="catalog__sort-label">{{ option.label }}</span>
        </button>
      </div>
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

const { title, description, category = undefined, categories } = defineProps<{
  title: string;
  description: string;
  category?: string;
  categories: Category[];
}>();

const breadcrumbs = computed(() => [
  { label: "Главная", to: "/" },
  { label: "Каталог", to: "/catalog" },
  ...(category ? [{ label: title, to: '/catalog/' + encodeURIComponent(category) }] : []),
]);

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
  min-width: 0;
  padding-block: var(--page-start) var(--page-end);
}

.catalog__head {
  margin-bottom: 1rem;
}

.catalog__title {
  font-size: var(--page-title);
  font-weight: 700;
  line-height: 1.1;
}

.catalog__text {
  margin-top: 0.5rem;
  color: var(--ui-text-muted);
}

.catalog__categories {
  margin-bottom: 1rem;
}

.catalog__toolbar {
  display: grid;
  gap: 0.75rem;
  margin-bottom: 1rem;
}

.catalog__search {
  display: grid;
  min-width: 0;
  width: 100%;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0.5rem;
  max-width: 42.5rem;
}

.catalog__search-input {
  min-width: 0;
  min-height: var(--touch-target);
}

.catalog__clear {
  min-width: var(--touch-target);
  min-height: var(--touch-target);
}

.catalog__submit {
  min-height: var(--touch-target);
  grid-column: 1 / -1;
  justify-content: center;
}

.catalog__sort {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  min-width: 0;
  gap: 0.25rem;
  padding: 0.25rem;
  border: 1px solid var(--ui-border);
  border-radius: 0.75rem;
  background: var(--ui-bg-muted);
}

.catalog__sort-option {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  min-height: var(--touch-target);
  padding: 0.25rem;
  border-radius: 0.5rem;
  color: var(--ui-text-muted);
  font-size: 0.8125rem;
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
}

.catalog__sort-option:hover {
  background: var(--ui-bg-elevated);
  color: var(--ui-text);
}

.catalog__sort-option[aria-pressed="true"] {
  background: var(--ui-bg);
  color: var(--ui-primary);
  box-shadow: inset 0 0 0 1px var(--ui-primary);
}

.catalog__sort-option:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: 2px;
}

.catalog__sort-icon {
  width: 1.25rem;
  height: 1.25rem;
  flex: none;
}

.catalog__sort-label {
  display: none;
}

.catalog__search :deep(input) {
  font-size: 1rem;
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
  font-size: var(--section-title);
  font-weight: 600;
}

.catalog__more {
  display: flex;
  justify-content: center;
  margin-top: 2rem;
}

.catalog__empty :deep(button),
.catalog__more :deep(button) {
  min-height: var(--touch-target);
}

@media (min-width: 40rem) {
  .catalog__sort-icon {
    display: none;
  }

  .catalog__sort-label {
    display: inline;
  }

  .catalog__head,
  .catalog__categories {
    margin-bottom: 1.5rem;
  }

  .catalog__toolbar {
    gap: 1rem;
    margin-bottom: 1.5rem;
  }

  .catalog__search {
    display: flex;
  }

  .catalog__search-input {
    flex: 1;
  }

  .catalog__submit {
    grid-column: auto;
  }
}

@media (width < 48rem) {
  .catalog__search {
    display: none;
  }
}

@media (min-width: 64rem) {
  .catalog__head,
  .catalog__categories {
    margin-bottom: 2rem;
  }
}
</style>
