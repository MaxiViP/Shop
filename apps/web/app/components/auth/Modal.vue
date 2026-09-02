<template>
  <UModal
    v-model:open="open"
    title="Вход"
    :description="description"
    :ui="{
      content: 'w-[calc(100%-2rem)] max-w-md max-h-[calc(100dvh-2rem)]',
      body: 'overflow-y-auto',
    }"
  >
    <template #body>
      <form
        class="auth"
        @submit.prevent="submit"
      >
        <template v-if="step === 'phone'">
          <UFormField
            label="Телефон"
            :error="error"
          >
            <UInput
              v-model="phone"
              type="tel"
              inputmode="tel"
              autocomplete="tel"
              placeholder="+7 999 123-45-67"
              size="lg"
              autofocus
            />
          </UFormField>

          <UButton
            type="submit"
            size="lg"
            block
            :loading="loading"
          >
            Получить код
          </UButton>
        </template>

        <template v-else>
          <UFormField
            label="Код подтверждения"
            :error="error"
          >
            <UInput
              v-model="code"
              inputmode="numeric"
              autocomplete="one-time-code"
              maxlength="6"
              placeholder="000000"
              size="lg"
              autofocus
            />
          </UFormField>

          <UAlert
            v-if="devCode"
            color="info"
            title="Dev-код"
            :description="devCode"
          />

          <UButton
            type="submit"
            size="lg"
            block
            :loading="loading"
          >
            Войти
          </UButton>

          <UButton
            variant="ghost"
            color="neutral"
            block
            @click="back"
          >
            Изменить номер
          </UButton>
        </template>
      </form>
    </template>
  </UModal>
</template>

<script setup lang="ts">
import type { User } from '~/types/user'
import { useAuthStore } from '~/stores/auth'

type Step = 'phone' | 'code'

const open = defineModel<boolean>('open', {
  required: true,
})

const auth = useAuthStore()
const api = useApiClient()
const toast = useToast()

const step = ref<Step>('phone')
const phone = ref('')
const code = ref('')
const devCode = ref('')
const error = ref('')
const loading = ref(false)

const description = computed(() =>
  step.value === 'phone'
    ? 'Введите номер телефона. Пароль не нужен.'
    : `Код отправлен на ${phone.value}`,
)

async function submit() {
  if (loading.value) return

  error.value = ''

  if (step.value === 'phone') {
    await requestCode()
    return
  }

  await login()
}

async function requestCode() {
  if (!phone.value.trim()) {
    error.value = 'Введите номер телефона'
    return
  }

  loading.value = true

  try {
    const result = await api<{
      ok: boolean
      devCode?: string
    }>('/auth/code', {
      method: 'POST',
      body: {
        phone: phone.value,
      },
    })

    devCode.value = result.devCode ?? ''
    step.value = 'code'
  } catch (cause) {
    error.value = getMessage(cause)
  } finally {
    loading.value = false
  }
}

async function login() {
  if (!/^\d{6}$/.test(code.value)) {
    error.value = 'Введите 6 цифр'
    return
  }

  loading.value = true

  try {
    const user = await api<User>('/auth/login', {
      method: 'POST',
      body: {
        phone: phone.value,
        code: code.value,
      },
    })

    auth.set(user)

    toast.add({
      title: 'Вы вошли',
    })

    close()
  } catch (cause) {
    error.value = getMessage(cause)
  } finally {
    loading.value = false
  }
}

function back() {
  step.value = 'phone'
  code.value = ''
  devCode.value = ''
  error.value = ''
}

function close() {
  open.value = false
  step.value = 'phone'
  code.value = ''
  devCode.value = ''
  error.value = ''
}

function getMessage(cause: unknown) {
  if (
    typeof cause === 'object'
    && cause
    && 'data' in cause
  ) {
    const data = cause.data

    if (
      typeof data === 'object'
      && data
      && 'message' in data
      && typeof data.message === 'string'
    ) {
      return data.message
    }
  }

  return 'Не удалось выполнить запрос'
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
