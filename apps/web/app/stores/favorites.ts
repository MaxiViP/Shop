import { computed, ref, watch } from "vue";
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
  let loadSequence = 0;
  let ownerSequence = 0;
  let mutationSequence = 0;
  const mutations = new Map<number, number>();

  watch(() => auth.user?.id, clearServer, { flush: "sync" });

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
    loadSequence++;
    ownerSequence++;
    syncPromise = null;
    pendingIds.value = [];
    mutations.clear();
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

    const sequence = ++loadSequence;
    const mutation = mutationSequence;
    const pending = [...pendingIds.value];
    const api = useApiClient();
    const result = await api<FavoriteListResponse>("/favorites");
    if (auth.user?.id !== userId || sequence !== loadSequence) return;
    const changed = new Set([...pending, ...pendingIds.value]);
    for (const [id, version] of mutations) {
      if (version > mutation) changed.add(id);
    }
    // Preserve local changes made while this server snapshot was in flight.
    serverItems.value = [
      ...serverItems.value.filter(({ id }) => changed.has(id)),
      ...result.items.filter(({ id }) => !changed.has(id)),
    ];
    serverIds.value = serverItems.value.map(({ id }) => id);
    loadedUserId.value = userId;
  }

  async function syncAfterLogin() {
    const userId = auth.user?.id;
    if (!userId) return;
    if (syncPromise) return syncPromise;

    const owner = ownerSequence;
    const promise = (async () => {
      const api = useApiClient();
      const productIds = [...guestIds.value];

      if (productIds.length) {
        await api("/favorites/sync", {
          method: "POST",
          body: { productIds },
        });
      }

      if (owner !== ownerSequence || auth.user?.id !== userId) return;
      await load(true);
      if (owner === ownerSequence && auth.user?.id === userId && productIds.length) {
        clearGuest();
      }
    })().finally(() => {
      if (syncPromise === promise) syncPromise = null;
    });

    syncPromise = promise;
    return promise;
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

    const userId = auth.user?.id;
    const owner = ownerSequence;
    const previousGuest = guestIds.value.includes(product.id);
    const previousId = serverIds.value.includes(product.id);
    const previousItem = serverItems.value.find(({ id }) => id === product.id);
    const wasFavorite = has(product.id);
    pendingIds.value = [...pendingIds.value, product.id];
    mutations.set(product.id, ++mutationSequence);

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
      if (owner === ownerSequence && auth.user?.id === userId) {
        guestIds.value = guestIds.value.filter((id) => id !== product.id);
        serverIds.value = serverIds.value.filter((id) => id !== product.id);
        serverItems.value = serverItems.value.filter(({ id }) => id !== product.id);
        if (previousGuest) guestIds.value = [...guestIds.value, product.id];
        if (previousId) serverIds.value = [...serverIds.value, product.id];
        if (previousItem) serverItems.value = [previousItem, ...serverItems.value];
      }
      throw error;
    } finally {
      if (owner === ownerSequence && auth.user?.id === userId) {
        mutations.set(product.id, ++mutationSequence);
        pendingIds.value = pendingIds.value.filter((id) => id !== product.id);
      }
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
