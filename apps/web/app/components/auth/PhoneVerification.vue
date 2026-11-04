<template>
  <form class="phone-verification" @submit.prevent="submit">
    <p>Подтвердите основной номер по SMS или повторно войдите через Telegram с доступом к номеру.</p>
    <UFormField label="Основной телефон">
      <AppTextInput v-model="phone" format="phone" autocomplete="tel" :disabled="sent || loading" />
    </UFormField>
    <UFormField v-if="sent" label="Код из SMS">
      <UInput v-model="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" :disabled="loading" />
    </UFormField>
    <p v-if="devCode" class="text-sm text-muted">Код для разработки: {{ devCode }}</p>
    <p v-if="error" role="alert" class="text-error">{{ error }}</p>
    <div class="phone-verification__actions">
      <UButton type="submit" :loading="loading">{{ sent ? "Подтвердить номер" : "Получить код" }}</UButton>
      <UButton v-if="sent" variant="ghost" :disabled="loading" @click="reset">Изменить номер</UButton>
      <UButton v-if="telegramAvailable" variant="soft" :disabled="loading" @click="telegramLogin">Подтвердить через Telegram</UButton>
    </div>
  </form>
</template>

<script setup lang="ts">
import type { User } from "~/types/user";
import { useAuthStore } from "~/stores/auth";

const auth = useAuthStore();
const api = useApiClient();
const phone = ref(auth.user?.phone ?? "");
const code = ref("");
const devCode = ref("");
const sent = ref(false);
const loading = ref(false);
const error = ref("");
const telegramAvailable = ref(false);

onMounted(async () => {
  try {
    telegramAvailable.value = (await api<{ websiteAvailable: boolean }>("/auth/telegram/config")).websiteAvailable;
  } catch { /* SMS remains available when Telegram is unavailable. */ }
});

function reset() {
  sent.value = false;
  code.value = "";
  devCode.value = "";
  error.value = "";
}

async function submit() {
  if (loading.value) return;
  loading.value = true;
  error.value = "";
  try {
    if (!sent.value) {
      const result = await api<{ demoCode?: string; devCode?: string }>("/auth/code", {
        method: "POST", body: { phone: phone.value },
      });
      if (result.demoCode !== undefined) {
        error.value = "Демонстрационный код не подтверждает номер. Используйте Telegram или дождитесь включения SMS.";
        return;
      }
      devCode.value = result.devCode ?? "";
      sent.value = true;
    } else {
      const user = await api<User>("/auth/login", {
        method: "POST", body: { phone: phone.value, code: code.value },
      });
      auth.set(user);
    }
  } catch (cause) {
    error.value = apiError(cause);
  } finally {
    loading.value = false;
  }
}

async function telegramLogin() {
  if (loading.value) return;
  loading.value = true;
  error.value = "";
  try {
    const result = await api<{ url: string }>("/auth/telegram/start", { method: "POST" });
    window.location.assign(result.url);
  } catch (cause) {
    error.value = apiError(cause);
    loading.value = false;
  }
}
</script>

<style scoped>
.phone-verification {
  display: grid;
  gap: 0.75rem;
}
.phone-verification__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}
</style>
