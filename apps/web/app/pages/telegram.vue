<template>
  <UContainer class="telegram-auth">
    <h1 class="text-2xl font-semibold">Открываем KorzinaMarket…</h1>
    <p role="status">{{ message }}</p>
    <UButton v-if="showFallback" to="/catalog">Открыть каталог</UButton>
  </UContainer>
</template>

<script setup lang="ts">
import type { User } from "~/types/user";
import { useAuthStore } from "~/stores/auth";
import { telegramReturnTo } from "~/utils/telegram-return";

useSeoMeta({ title: "Вход через Telegram", robots: "noindex, follow" });
const route = useRoute();
const api = useApiClient();
const auth = useAuthStore();
const message = ref("Открываем…");
const showFallback = ref(false);
const destination = telegramReturnTo(route.query.returnTo);
const fromWebAppButton = route.query.returnTo !== undefined;

type TelegramWindow = Window & {
  Telegram?: { WebApp?: { initData: string; ready: () => void } };
};
let stopped = false;
let cancelLoad: (() => void) | undefined;

onBeforeUnmount(() => {
  stopped = true;
  cancelLoad?.();
});

onMounted(async () => {
  try {
    // A bot WebApp launch sends its signed proof immediately. The normal entry
    // keeps the existing SID shortcut for visitors without a returnTo.
    if (!fromWebAppButton) {
      const currentUser = await api<User | null>("/auth/me");
      if (stopped) return;
      auth.set(currentUser);
      if (currentUser) {
        await navigateTo(destination, { replace: true });
        return;
      }
    }
    if (route.query.error) {
      message.value = "Вход не завершён. Откройте страницу заново из Telegram.";
      showFallback.value = true;
      return;
    }
    if (!(window as TelegramWindow).Telegram?.WebApp) {
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "https://telegram.org/js/telegram-web-app.js";
        script.async = true;
        const timer = setTimeout(() => finish(false), 8000);
        function finish(ok: boolean) {
          clearTimeout(timer);
          script.onload = null;
          script.onerror = null;
          cancelLoad = undefined;
          if (!ok) script.remove();
          if (ok) resolve();
          else reject(new Error("SDK_UNAVAILABLE"));
        }
        script.onload = () => finish(true);
        script.onerror = () => finish(false);
        cancelLoad = () => finish(false);
        document.head.append(script);
      });
    }
    if (stopped) return;
    const app = (window as TelegramWindow).Telegram?.WebApp;
    if (!app?.initData) {
      message.value = "Откройте эту страницу кнопкой в Telegram, чтобы войти автоматически.";
      showFallback.value = true;
      return;
    }
    app.ready();
    const user = await api<User>("/auth/telegram/mini-app", {
      method: "POST", body: { initData: app.initData },
    });
    if (stopped) return;
    auth.set(user);
    await navigateTo(destination, { replace: true });
  } catch (cause) {
    if (!stopped) {
      message.value = apiError(cause);
      showFallback.value = true;
    }
  }
});
</script>

<style scoped>
.telegram-auth {
  display: grid;
  justify-items: start;
  gap: 1rem;
  padding-block: 2rem;
}
</style>
