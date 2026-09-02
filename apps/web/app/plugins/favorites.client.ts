import { watch } from "vue";
import { defineNuxtPlugin } from "#app";
import { useAuthStore } from "~/stores/auth";
import { useFavoritesStore } from "~/stores/favorites";

const key = "favorites";

export default defineNuxtPlugin((nuxtApp) => {
  const auth = useAuthStore();
  const favorites = useFavoritesStore();
  const toast = useToast();

  nuxtApp.hook("app:mounted", () => {
    try {
      const data = localStorage.getItem(key);
      favorites.restoreGuest(data ? JSON.parse(data) : []);
    } catch {
      localStorage.removeItem(key);
    }

    favorites.$subscribe((_mutation, state) => {
      localStorage.setItem(key, JSON.stringify(state.guestIds));
    });

    watch(
      () => auth.user?.id,
      (userId) => {
        if (!userId) {
          favorites.clearServer();
          return;
        }

        void favorites.syncAfterLogin().catch(() => {
          toast.add({
            title: "Не удалось синхронизировать избранное",
            description:
              "Локальное избранное сохранено. Попробуем снова позже.",
            color: "error",
          });
        });
      },
      { immediate: true },
    );
  });
});
