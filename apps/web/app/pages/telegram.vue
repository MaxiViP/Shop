<template>
  <UContainer class="telegram-auth">
    <h1 class="text-2xl font-semibold">Вход через Telegram</h1>
    <p role="status">{{ message }}</p>
    <UButton to="/catalog">Продолжить без регистрации</UButton>
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
const message = ref("Проверяем вход…");
const destination = telegramReturnTo(route.query.returnTo);
const fromWebAppButton = route.query.returnTo !== undefined;
const proofKey = "korzinamarket:telegram-mini-app-proof";

async function proofFingerprint(initData: string): Promise<string | null> {
  if (!window.crypto?.subtle) return null;
  const digest = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(initData));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
function savedProof(): string | null {
  try { return window.sessionStorage.getItem(proofKey); } catch { return null; }
}
function rememberProof(value: string) {
  try { window.sessionStorage.setItem(proofKey, value); } catch { /* Storage may be unavailable. */ }
}
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
    // Refresh the regular SID session before consuming a one-time Telegram proof.
    const currentUser = await api<User | null>("/auth/me");
    if (stopped) return;
    auth.set(currentUser);
    if (currentUser && !fromWebAppButton) {
      await navigateTo(destination, { replace: true });
      return;
    }
    if (route.query.error) {
      message.value = "Вход не завершён. Повторите вход через Telegram. Для объединения разных аккаунтов потребуется отдельная привязка.";
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
      message.value = "Откройте мини-приложение из Telegram или воспользуйтесь кнопкой входа на сайте.";
      return;
    }
    app.ready();
    const fingerprint = await proofFingerprint(app.initData);
    if (stopped) return;
    if (currentUser && fingerprint && savedProof() === currentUser.id + ":" + fingerprint) {
      await navigateTo(destination, { replace: true });
      return;
    }
    const user = await api<User>("/auth/telegram/mini-app", {
      method: "POST", body: { initData: app.initData },
    });
    if (fingerprint) rememberProof(user.id + ":" + fingerprint);
    if (stopped) return;
    auth.set(user);
    await navigateTo(destination, { replace: true });
  } catch (cause) {
    if (!stopped) message.value = apiError(cause);
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
