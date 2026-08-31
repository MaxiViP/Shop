<template>
  <header class="header">
    <UContainer class="header__inner">
      <NuxtLink to="/" class="header__logo"> Market </NuxtLink>

      <nav class="header__nav">
        <NuxtLink to="/catalog"> Каталог </NuxtLink>

        <NuxtLink to="/delivery"> Доставка </NuxtLink>
      </nav>

      <div class="header__actions">
        <UButton
          v-if="auth.user?.role === 'ADMIN'"
          to="/admin/orders"
          icon="i-lucide-clipboard-list"
          variant="ghost"
          color="neutral"
          aria-label="Управление заказами"
        />

        <UButton
          v-if="auth.loggedIn"
          to="/profile"
          icon="i-lucide-user"
          variant="ghost"
          color="neutral"
          aria-label="Профиль"
        />

        <UButton
          v-else
          icon="i-lucide-user"
          variant="ghost"
          color="neutral"
          aria-label="Войти"
          @click="loginOpen = true"
        />

        <div class="header__cart">
          <UButton
            to="/cart"
            icon="i-lucide-shopping-bag"
            variant="ghost"
            color="neutral"
            aria-label="Корзина"
          />

          <span v-if="cart.count" class="header__count">
            {{ cart.count }}
          </span>
        </div>
        <UButton
          to="/orders"
          icon="i-lucide-package"
          variant="ghost"
          color="neutral"
          aria-label="Мои заказы"
        />
      </div>
    </UContainer>

    <AuthModal v-model:open="loginOpen" />
  </header>
</template>

<script setup lang="ts">
import { useAuthStore } from "~/stores/auth";
import { useCartStore } from "~/stores/cart";

const auth = useAuthStore();
const cart = useCartStore();

const loginOpen = ref(false);
</script>

<style scoped>
.header {
  border-bottom: 1px solid var(--ui-border);
}

.header__inner {
  display: flex;
  height: 72px;
  align-items: center;
  gap: 2rem;
}

.header__logo {
  font-size: 1.25rem;
  font-weight: 700;
}

.header__nav {
  display: flex;
  gap: 1.5rem;
  margin-right: auto;
}

.header__actions {
  display: flex;
  gap: 0.25rem;
}

.header__cart {
  position: relative;
}

.header__count {
  position: absolute;
  top: -3px;
  right: -5px;
  display: grid;
  min-width: 18px;
  height: 18px;
  padding-inline: 4px;
  place-items: center;
  border-radius: 999px;
  background: var(--ui-primary);
  color: white;
  font-size: 0.7rem;
  font-weight: 700;
  pointer-events: none;
}
</style>
