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

useHead({
  script: [{
    key: "telegram-web-app-sdk",
    src: "https://telegram.org/js/telegram-web-app.js?63",
    tagPosition: "head",
    tagPriority: "critical",
  }],
});

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

onBeforeUnmount(() => {
  stopped = true;
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
    const app = (window as TelegramWindow).Telegram?.WebApp;
    app?.ready();
    const initData = app?.initData ?? "";
    const fields = new URLSearchParams(initData);
    if (!["auth_date", "hash", "user"].every((name) => Boolean(fields.get(name)))) {
      message.value = "Откройте эту страницу кнопкой в Telegram, чтобы войти автоматически.";
      showFallback.value = true;
      return;
    }
    const user = await api<User>("/auth/telegram/mini-app", {
      method: "POST", body: { initData },
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
