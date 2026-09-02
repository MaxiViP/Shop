import { computed, ref } from "vue";
import { defineStore } from "pinia";
import type { FavoriteListResponse, ProductListItem } from "~/types/product";
import { useAuthStore } from "~/stores/auth";

const MAX_GUEST_FAVORITES = 100;

export const useFavoritesStore = defineStore("favorites", () => {
  const auth = useAuthStore();
  const guestIds = ref<number[]>([]);
  const serverIds = ref<number[]>([]);
  const serverItems = ref<ProductListItem[]>([]);
  const pendingIds = ref<number[]>([]);
  const loadedUserId = ref<number | null>(null);
  let syncPromise: Promise<void> | null = null;

  const ids = computed(() =>
    auth.loggedIn
      ? [...new Set([...serverIds.value, ...guestIds.value])]
      : guestIds.value,
  );
  const count = computed(() => ids.value.length);

  function has(productId: number) {
    return ids.value.includes(productId);
  }

  function pending(productId: number) {
    return pendingIds.value.includes(productId);
  }

  function restoreGuest(value: unknown) {
    if (!Array.isArray(value)) return;

    guestIds.value = [
      ...new Set(
        value.filter(
          (id): id is number => Number.isInteger(id) && Number(id) > 0,
        ),
      ),
    ].slice(0, MAX_GUEST_FAVORITES);
  }

  function clearGuest() {
    guestIds.value = [];
  }

  function clearServer() {
    serverIds.value = [];
    serverItems.value = [];
    loadedUserId.value = null;
  }

  async function load(force = false) {
    const userId = auth.user?.id;
    if (!userId) {
      clearServer();
      return;
    }
    if (!force && loadedUserId.value === userId) return;

    const api = useApiClient();
    const result = await api<FavoriteListResponse>("/favorites");
    serverItems.value = result.items;
    serverIds.value = result.items.map(({ id }) => id);
    loadedUserId.value = userId;
  }

  async function syncAfterLogin() {
    if (!auth.user) return;
    if (syncPromise) return syncPromise;

    syncPromise = (async () => {
      const api = useApiClient();
      const productIds = [...guestIds.value];

      if (productIds.length) {
        await api("/favorites/sync", {
          method: "POST",
          body: { productIds },
        });
      }

      await load(true);
      if (productIds.length) clearGuest();
    })().finally(() => {
      syncPromise = null;
    });

    return syncPromise;
  }

  async function toggle(product: ProductListItem) {
    if (!auth.loggedIn) {
      if (has(product.id)) {
        guestIds.value = guestIds.value.filter((id) => id !== product.id);
        return;
      }
      if (guestIds.value.length >= MAX_GUEST_FAVORITES) {
        throw new Error("Можно сохранить не более 100 товаров");
      }

      guestIds.value = [...guestIds.value, product.id];
      return;
    }

    if (pending(product.id)) return;

    const previousGuest = [...guestIds.value];
    const previousIds = [...serverIds.value];
    const previousItems = [...serverItems.value];
    const wasFavorite = has(product.id);
    pendingIds.value = [...pendingIds.value, product.id];

    if (wasFavorite) {
      serverIds.value = serverIds.value.filter((id) => id !== product.id);
      serverItems.value = serverItems.value.filter(
        ({ id }) => id !== product.id,
      );
      guestIds.value = guestIds.value.filter((id) => id !== product.id);
    } else {
      serverIds.value = [...serverIds.value, product.id];
      serverItems.value = [product, ...serverItems.value];
    }

    try {
      const api = useApiClient();
      await api(`/favorites/${product.id}`, {
        method: wasFavorite ? "DELETE" : "POST",
      });
    } catch (error) {
      guestIds.value = previousGuest;
      serverIds.value = previousIds;
      serverItems.value = previousItems;
      throw error;
    } finally {
      pendingIds.value = pendingIds.value.filter((id) => id !== product.id);
    }
  }

  return {
    guestIds,
    serverIds,
    serverItems,
    ids,
    count,
    has,
    pending,
    restoreGuest,
    clearGuest,
    clearServer,
    load,
    syncAfterLogin,
    toggle,
  };
});
