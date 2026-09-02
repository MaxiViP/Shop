<template>
  <UContainer class="favorites-page">
    <h1 class="favorites-page__title">Избранное</h1>

    <p v-if="loading" class="favorites-page__state">Загружаем...</p>

    <UAlert
      v-if="loadError"
      class="favorites-page__error"
      title="Не удалось загрузить избранное"
      description="Попробуйте обновить страницу. Сохранённые в браузере товары не потеряны."
      color="error"
    />

    <ProductGrid v-if="items.length" :items="items" />

    <div v-else-if="!loading && !loadError" class="favorites-page__empty">
      <h2 class="favorites-page__empty-title">В избранном пока ничего нет</h2>
      <UButton to="/catalog" size="lg">Перейти в каталог</UButton>
    </div>
  </UContainer>
</template>

<script setup lang="ts">
import type { ProductListItem, ProductListResponse } from "~/types/product";
import { useAuthStore } from "~/stores/auth";
import { useFavoritesStore } from "~/stores/favorites";

const auth = useAuthStore();
const favorites = useFavoritesStore();
const api = useApiClient();
const guestItems = ref<ProductListItem[]>([]);
const loading = ref(false);
const loadError = ref(false);
let requestId = 0;

const currentGuestItems = computed(() => {
  const ids = new Set(favorites.guestIds);
  return guestItems.value.filter(({ id }) => ids.has(id));
});
const items = computed(() => {
  if (!auth.loggedIn) return currentGuestItems.value;

  const serverIds = new Set(favorites.serverItems.map(({ id }) => id));
  return [
    ...favorites.serverItems,
    ...currentGuestItems.value.filter(({ id }) => !serverIds.has(id)),
  ];
});

onMounted(() => {
  void refresh();
});

watch(
  () => [auth.user?.id ?? null, favorites.guestIds.join(",")] as const,
  () => {
    void refresh();
  },
);

async function refresh() {
  const currentRequest = ++requestId;
  loading.value = true;
  loadError.value = false;
  let failed = false;
  let loadedGuestItems: ProductListItem[] | null = null;

  if (auth.loggedIn) {
    try {
      await favorites.syncAfterLogin();
    } catch {
      failed = true;
    }
  }

  try {
    loadedGuestItems = await fetchGuestProducts();
  } catch {
    failed = true;
  }

  if (currentRequest !== requestId) return;
  if (loadedGuestItems) guestItems.value = loadedGuestItems;
  loadError.value = failed;
  loading.value = false;
}

async function fetchGuestProducts() {
  const ids = [...favorites.guestIds];
  if (!ids.length) return [];

  const chunks: number[][] = [];
  for (let index = 0; index < ids.length; index += 60) {
    chunks.push(ids.slice(index, index + 60));
  }

  const responses = await Promise.all(
    chunks.map((chunk) =>
      api<ProductListResponse>("/products", {
        query: {
          ids: chunk.join(","),
          sort: "name",
          limit: 60,
        },
      }),
    ),
  );
  return responses.flatMap(({ items }) => items);
}

useSeoMeta({
  title: "Избранное",
  description: "Сохранённые продукты с московского рынка.",
});
</script>

<style scoped>
.favorites-page {
  padding-block: 3rem 5rem;
}

.favorites-page__title {
  margin-bottom: 2rem;
  font-size: 2.5rem;
  font-weight: 700;
}

.favorites-page__state {
  color: var(--ui-text-muted);
}

.favorites-page__error {
  margin-bottom: 1.5rem;
}

.favorites-page__empty {
  display: grid;
  justify-items: start;
  gap: 1rem;
  padding-block: 3rem;
}

.favorites-page__empty-title {
  font-size: 1.5rem;
  font-weight: 600;
}
</style>
