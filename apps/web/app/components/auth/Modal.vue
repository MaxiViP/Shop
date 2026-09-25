<template>
  <UModal
    v-model:open="open"
    :title="mode === 'PASSWORD' ? 'Вход' : 'Вход или регистрация'"
    :description="description"
    :dismissible="!loading && !telegramLoading"
    :ui="{
      content: 'w-[calc(100%-2rem)] max-w-md max-h-[calc(100dvh-2rem)]',
      body: 'overflow-y-auto',
    }"
  >
    <template #body>
      <form class="auth" @submit.prevent="submit">
        <UButton
type="button" size="lg" block icon="i-lucide-send"
          :loading="telegramLoading" :disabled="loading || !telegramAvailable" @click="telegramLogin">
          Войти через Telegram
        </UButton>
        <p v-if="!telegramAvailable" class="text-sm text-muted">
          Вход через Telegram пока недоступен. Можно продолжить без регистрации.
        </p>
        <UButton
type="button" variant="ghost" color="neutral" block
          :disabled="loading || telegramLoading" @click="open = false">
          Продолжить без регистрации
        </UButton>
        <UFormField v-if="!codeSent" label="Телефон">
          <AppTextInput
            v-model="phone"
            format="phone"
            type="tel"
            inputmode="tel"
            autocomplete="tel"
            placeholder="+7 999 123 45 67"
            size="lg"
            autofocus
            :disabled="loading || telegramLoading"
          />
        </UFormField>

        <p
          v-if="mode === 'CHECKING_METHOD'"
          role="status"
          class="text-sm text-muted"
        >
          Определяем способ входа…
        </p>

        <UFormField v-if="mode === 'PASSWORD'" label="Пароль">
          <UInput
            v-model="password"
            type="password"
            autocomplete="current-password"
            size="lg"
            required
            :disabled="loading || telegramLoading"
          />
        </UFormField>

        <template v-if="mode === 'OTP' && codeSent">
          <UFormField label="Код подтверждения">
            <UInput
              v-model="code"
              inputmode="numeric"
              autocomplete="one-time-code"
              maxlength="6"
              placeholder="000000"
              size="lg"
              autofocus
              :disabled="loading || telegramLoading"
            />
          </UFormField>
          <UAlert
            v-if="devCode"
            color="info"
            title="Dev-код"
            :description="devCode"
          />
        </template>

        <UAlert v-if="message" color="error" :title="message" />
        <UButton
          type="submit"
          size="lg"
          block
          :loading="loading"
          :disabled="
            telegramLoading || mode === 'CHECKING_METHOD' || (mode === 'PHONE' && !methodError)
          "
        >
          {{
            mode === "PASSWORD" || codeSent
              ? "Войти"
              : mode === "OTP"
                ? "Получить код"
                : methodError
                  ? "Повторить"
                  : "Введите телефон"
          }}
        </UButton>
        <UButton
          v-if="codeSent"
          variant="ghost"
          color="neutral"
          block
          :disabled="loading || telegramLoading"
          @click="back"
        >
          Изменить номер
        </UButton>
      </form>
    </template>
  </UModal>
</template>

<script setup lang="ts">
import type { User } from "~/types/user";
import { useAuthStore } from "~/stores/auth";

const open = defineModel<boolean>("open", { required: true });
const auth = useAuthStore();
const api = useApiClient();
const adminLogin = useAdminLogin();
const toast = useToast();
const route = useRoute();
const phone = ref("");
const password = ref("");
const code = ref("");
const codeSent = ref(false);
const devCode = ref("");
const error = ref("");
const loading = ref(false);
const telegramLoading = ref(false);
const telegramAvailable = ref(false);

watch(open, async (value) => {
  if (!value) return;
  try {
    const config = await api<{ websiteAvailable: boolean }>("/auth/telegram/config");
    telegramAvailable.value = config.websiteAvailable;
  } catch {
    telegramAvailable.value = false;
  }
}, { immediate: true });

async function telegramLogin() {
  if (loading.value || telegramLoading.value || !telegramAvailable.value) return;
  telegramLoading.value = true;
  error.value = "";
  try {
    const returnTo = /^\/order\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(route.path) ? route.path : undefined;
    const result = await api<{ url: string }>("/auth/telegram/start", {
      method: "POST", ...(returnTo ? { body: { returnTo } } : {}),
    });
    window.location.assign(result.url);
  } catch {
    error.value = "Не удалось начать вход через Telegram. Попробуйте ещё раз.";
    telegramLoading.value = false;
  }
}
const {
  mode,
  error: methodError,
  change,
  reset,
} = useLoginMethod((phone) =>
  api<{ method: 'OTP' | 'PASSWORD' }>("/auth/method", { method: "POST", body: { phone } }),
);
const message = computed(
  () => error.value || (methodError.value ? apiError(methodError.value) : ""),
);
const description = computed(() =>
  codeSent.value
    ? `Код отправлен на ${phone.value}`
    : mode.value === "PASSWORD"
      ? "Введите пароль для входа."
      : "Введите номер телефона.",
);

function clearFields() {
  password.value = "";
  code.value = "";
  codeSent.value = false;
  devCode.value = "";
  error.value = "";
}

watch(
  phone,
  () => {
    clearFields();
    if (open.value) change(phone.value);
    else reset();
  },
  { flush: "sync" },
);

watch(
  open,
  (value) => {
    clearFields();
    if (value) change(phone.value);
    else reset();
  },
  { flush: "sync" },
);

onBeforeUnmount(reset);

function back() {
  clearFields();
  change(phone.value);
}

async function submit() {
  if (loading.value || telegramLoading.value || mode.value === "CHECKING_METHOD") return;
  error.value = "";
  if (mode.value === "PHONE") {
    change(phone.value, 0);
    return;
  }
  if (mode.value === "OTP" && codeSent.value && !/^\d{6}$/.test(code.value)) {
    error.value = "Введите 6 цифр";
    return;
  }

  loading.value = true;
  try {
    if (mode.value === "PASSWORD") {
      await adminLogin(phone.value, password.value);
    } else if (!codeSent.value) {
      const result = await api<{ ok: boolean; devCode?: string }>(
        "/auth/code",
        {
          method: "POST",
          body: { phone: phone.value },
        },
      );
      devCode.value = result.devCode ?? "";
      codeSent.value = true;
      return;
    } else {
      auth.set(
        await api<User>("/auth/login", {
          method: "POST",
          body: { phone: phone.value, code: code.value },
        }),
      );
    }
    toast.add({ title: "Вы вошли" });
    open.value = false;
  } catch (cause) {
    error.value = apiError(cause);
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.auth {
  display: grid;
  gap: 1rem;
}

.auth :deep(input) {
  font-size: 1rem;
}

.auth :deep(button) {
  min-height: var(--touch-target);
}
</style>
