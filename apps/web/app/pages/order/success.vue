<template>
  <UContainer class="success">
    <div class="success__icon">
      <UIcon name="i-lucide-check" />
    </div>

    <p class="success__label">
      Заказ принят
    </p>

    <h1 class="success__title">
      Спасибо!
    </h1>

    <p class="success__text">
      Заказ
      <strong>#{{ orderId }}</strong>
      успешно оформлен.
    </p>

    <p class="success__hint">
      Мы свяжемся с вами, если потребуется
      уточнить детали заказа.
    </p>

    <div class="success__actions">
      <UButton to="/catalog">
        Продолжить покупки
      </UButton>

      <UButton
        v-if="auth.loggedIn"
        to="/profile"
        variant="soft"
        color="neutral"
      >
        Личный кабинет
      </UButton>
    </div>
  </UContainer>
</template>

<script setup lang="ts">
import { useAuthStore } from '~/stores/auth'

const route = useRoute()
const auth = useAuthStore()

const orderId = computed(
  () => String(route.query.id ?? ''),
)

if (!orderId.value) {
  await navigateTo('/')
}

useSeoMeta({
  title: 'Заказ принят',
})
</script>

<style scoped>
.success {
  display: grid;
  max-width: 620px;
  min-height: calc(100vh - 72px);
  align-content: center;
  justify-items: center;
  padding-block: 4rem;
  text-align: center;
}

.success__icon {
  display: grid;
  width: 72px;
  height: 72px;
  place-items: center;
  border-radius: 50%;
  background: var(--ui-primary);
  color: white;
}

.success__icon svg {
  width: 2rem;
  height: 2rem;
}

.success__label {
  margin-top: 1.5rem;
  color: var(--ui-primary);
  font-weight: 600;
}

.success__title {
  margin-top: 0.25rem;
  font-size: 3rem;
  font-weight: 700;
}

.success__text {
  margin-top: 1rem;
  font-size: 1.125rem;
}

.success__hint {
  max-width: 440px;
  margin-top: 0.5rem;
  color: var(--ui-text-muted);
}

.success__actions {
  display: flex;
  gap: 0.75rem;
  margin-top: 2rem;
}
</style>
