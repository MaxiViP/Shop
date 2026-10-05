<template>
  <UModal
    v-model:open="open"
    :title="mode === 'PASSWORD' ? 'Вход' : 'Вход или регистрация'"
    :description="description"
    :dismissible="otpStage === 'showing' || (!loading && !telegramLoading)"
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
            placeholder="+7 (___) ___-__-__"
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

        <p v-if="otpStage === 'generating'" class="text-sm text-muted" role="status">
          Генерируем код...
        </p>

        <p v-if="mode === 'TEST_PHONE'" class="text-sm text-muted">
          Тестовый режим: подтверждение номера телефона временно отключено.
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
            <div class="auth__otp">
              <input
                :value="code"
                class="auth__otp-input"
                type="text"
                inputmode="numeric"
                autocomplete="one-time-code"
                maxlength="6"
                autofocus
                aria-label="Код подтверждения"
                :aria-invalid="Boolean(message)"
                :disabled="loading || telegramLoading"
                @input="onOtpInput"
                @focus="otpFocused = true"
                @blur="otpFocused = false"
              >
              <span class="auth__otp-cells" aria-hidden="true">
                <span
                  v-for="index in 6"
                  :key="index"
                  class="auth__otp-cell"
                  :class="{
                    'auth__otp-cell--filled': code.length >= index,
                    'auth__otp-cell--active':
                      (otpStage === 'showing' || otpFocused) && index === Math.min(code.length + 1, 6),
                  }"
                >{{ code[index - 1] ?? "" }}</span>
              </span>
            </div>
          </UFormField>
          <UAlert
            v-if="demoCode"
            color="info"
            :title="`Код: ${demoCode}`"
            role="status"
          />
          <p v-if="otpStage === 'logging-in'" class="text-sm text-muted" role="status">
            Выполняется вход...
          </p>
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
              : mode === "TEST_PHONE"
                ? "Войти или зарегистрироваться"
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
const demoCode = ref("");
const otpStage = ref<"idle" | "generating" | "showing" | "logging-in">("idle");
const otpFocused = ref(false);
const error = ref("");
let flowRevision = 0;
let otpAbort: AbortController | null = null;
let pendingWebOtpCode: string | null = null;
let cancelPause: (() => void) | null = null;
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
    const returnTo = /^\/order\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\?chatMessage=[1-9][0-9]{0,9})?(?:#order-chat)?$/i.test(route.fullPath) ? route.fullPath : undefined;
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
  api<{ method: 'OTP' | 'PASSWORD' | 'TEST_PHONE' }>("/auth/method", { method: "POST", body: { phone } }),
);
const message = computed(
  () => error.value || (methodError.value ? apiError(methodError.value) : ""),
);
const description = computed(() =>
  codeSent.value
    ? demoCode.value ? "Код для тестового входа показан ниже." : `Код отправлен на ${phone.value}`
    : mode.value === "PASSWORD"
      ? "Введите пароль для входа."
      : "Введите номер телефона.",
);

function cancelPending() {
  flowRevision++;
  cancelPause?.();
  otpAbort?.abort();
  otpAbort = null;
  pendingWebOtpCode = null;
}

function pause(ms: number) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (cancelPause === cancel) cancelPause = null;
      resolve();
    }, ms);
    function cancel() {
      clearTimeout(timer);
      if (cancelPause === cancel) cancelPause = null;
      resolve();
    }
    cancelPause = cancel;
  });
}

function onOtpInput(event: Event) {
  const input = event.target as HTMLInputElement;
  code.value = input.value.replace(/\D/g, "").slice(0, 6);
  input.value = code.value;
}

async function animateOtp(value: string, revision: number) {
  const reduced = typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  code.value = "";
  otpStage.value = "showing";
  for (let index = 0; index < value.length; index++) {
    if (index > 0 && !reduced) await pause(175);
    if (revision !== flowRevision || !open.value) return false;
    code.value += value[index];
  }
  await pause(400);
  if (revision !== flowRevision || !open.value) return false;
  otpStage.value = "logging-in";
  return true;
}

async function loginOtp(revision: number) {
  const user = await api<User>("/auth/login", {
    method: "POST", body: { phone: phone.value, code: code.value },
  });
  if (revision !== flowRevision || !open.value) return false;
  auth.set(user);
  return true;
}

async function submitAutomaticCode(value: string, revision: number) {
  if (loading.value || !codeSent.value || revision !== flowRevision || !open.value) return;
  loading.value = true;
  try {
    if (!await animateOtp(value, revision) || !await loginOtp(revision)) return;
    toast.add({ title: "Вы вошли" });
    open.value = false;
  } catch (cause) {
    if (revision === flowRevision) {
      otpStage.value = "idle";
      error.value = apiError(cause);
    }
  } finally {
    loading.value = false;
  }
}

function clearFields() {
  cancelPending();
  password.value = "";
  code.value = "";
  otpFocused.value = false;
  codeSent.value = false;
  devCode.value = "";
  demoCode.value = "";
  otpStage.value = "idle";
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

onBeforeUnmount(() => {
  cancelPending();
  reset();
});

function back() {
  clearFields();
  change(phone.value);
}

function startWebOtp(revision: number) {
  if (typeof window === "undefined" || typeof navigator === "undefined" ||
    !("OTPCredential" in window) || !navigator.credentials) return;
  const controller = new AbortController();
  otpAbort = controller;
  const credentials = navigator.credentials as unknown as {
    get(options: { otp: { transport: ["sms"] }; signal: AbortSignal }):
      Promise<{ code?: string } | null>;
  };
  let request: Promise<{ code?: string } | null>;
  try {
    request = credentials.get({
      otp: { transport: ["sms"] },
      signal: controller.signal,
    });
  } catch {
    otpAbort = null;
    return;
  }
  void request.then((credential) => {
    if (controller.signal.aborted || revision !== flowRevision ||
      !open.value || mode.value !== "OTP" ||
      !credential?.code || !/^\d{6}$/.test(credential.code)) return;
    pendingWebOtpCode = credential.code;
    if (codeSent.value && !loading.value) {
      const received = pendingWebOtpCode;
      pendingWebOtpCode = null;
      void submitAutomaticCode(received, revision);
    }
  }).catch(() => {
    // WebOTP is optional; the code field remains available for manual entry.
  });
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
  const revision = flowRevision;
  try {
    if (mode.value === "PASSWORD") {
      await adminLogin(phone.value, password.value);
    } else if (mode.value === "TEST_PHONE") {
      auth.set(await api<User>("/auth/test-phone-login", {
        method: "POST", body: { phone: phone.value },
      }));
    } else if (!codeSent.value) {
      otpStage.value = "generating";
      // WebOTP must listen before an SMS can be sent. DEMO/DEV cancel it on response.
      startWebOtp(revision);
      const result = await api<{ ok: boolean; devCode?: string; demoCode?: string }>(
        "/auth/code",
        { method: "POST", body: { phone: phone.value } },
      );
      if (revision !== flowRevision || !open.value) return;
      if (!result.ok) throw new Error("OTP_REQUEST_FAILED");
      if (result.demoCode !== undefined && !/^\d{6}$/.test(result.demoCode))
        throw new Error("OTP_RESPONSE_INVALID");
      if (result.demoCode || result.devCode) {
        otpAbort?.abort();
        otpAbort = null;
        pendingWebOtpCode = null;
      }
      devCode.value = result.devCode ?? "";
      codeSent.value = true;
      if (result.demoCode) {
        demoCode.value = result.demoCode;
        if (!await animateOtp(result.demoCode, revision) || !await loginOtp(revision)) return;
      } else {
        otpStage.value = "idle";
        return;
      }
    } else {
      otpAbort?.abort();
      otpAbort = null;
      pendingWebOtpCode = null;
      if (!await loginOtp(revision)) return;
    }
    if (revision !== flowRevision || !open.value) return;
    toast.add({ title: "Вы вошли" });
    open.value = false;
  } catch (cause) {
    if (revision === flowRevision) {
      if (!codeSent.value) {
        otpAbort?.abort();
        otpAbort = null;
        pendingWebOtpCode = null;
      }
      otpStage.value = "idle";
      error.value = apiError(cause);
    }
  } finally {
    loading.value = false;
    if (pendingWebOtpCode && codeSent.value && revision === flowRevision &&
      open.value && mode.value === "OTP") {
      const received = pendingWebOtpCode;
      pendingWebOtpCode = null;
      void submitAutomaticCode(received, revision);
    }
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

.auth__otp {
  position: relative;
  width: 100%;
  max-width: 22rem;
}

.auth__otp-input {
  position: absolute;
  inset: 0;
  z-index: 1;
  width: 100%;
  height: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  color: transparent;
  caret-color: transparent;
  font-size: 1rem;
}

.auth__otp-cells {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: clamp(0.25rem, 1.5vw, 0.5rem);
  pointer-events: none;
}

.auth__otp-cell {
  display: grid;
  min-width: 0;
  height: 2.75rem;
  place-items: center;
  border: 1px solid var(--ui-border);
  border-radius: 0.5rem;
  background: var(--ui-bg);
  color: var(--ui-text-highlighted);
  font-size: 1.125rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  transition: border-color 175ms ease, background-color 175ms ease, box-shadow 175ms ease;
}

.auth__otp-cell--active {
  border-color: var(--ui-primary);
  background: color-mix(in srgb, var(--ui-primary) 8%, var(--ui-bg));
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ui-primary) 20%, transparent);
}

.auth__otp-input:focus-visible + .auth__otp-cells .auth__otp-cell--active {
  outline: 2px solid var(--ui-primary);
  outline-offset: 2px;
}

.auth__otp-cell--filled {
  animation: auth-otp-digit 180ms ease-out;
}

@keyframes auth-otp-digit {
  from { opacity: 0.45; transform: translateY(0.25rem) scale(0.9); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

@media (prefers-reduced-motion: reduce) {
  .auth__otp-cell {
    transition: none;
  }

  .auth__otp-cell--filled {
    animation: none;
  }
}
</style>
