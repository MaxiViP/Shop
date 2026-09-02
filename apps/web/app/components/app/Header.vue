<template>
  <header class="header">
    <UContainer class="header__inner">
      <UButton
        class="header__menu"
        icon="i-lucide-menu"
        variant="ghost"
        color="neutral"
        aria-label="Открыть меню"
        :aria-expanded="mobileOpen"
        @click="mobileOpen = true"
      />

      <NuxtLink to="/" class="header__logo">Market</NuxtLink>

      <nav class="header__nav" aria-label="Основная навигация">
        <NuxtLink to="/catalog">Каталог</NuxtLink>
        <NuxtLink to="/delivery">Доставка</NuxtLink>
      </nav>

      <div class="header__actions">
        <UButton
          v-if="staff"
          to="/staff/orders"
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

        <div class="header__action">
          <UButton
            to="/favorites"
            icon="i-lucide-heart"
            variant="ghost"
            color="neutral"
            aria-label="Избранное"
          />
          <span v-if="favorites.count" class="header__count">
            {{ favorites.count }}
          </span>
        </div>

        <div class="header__action">
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

      <div class="header__mobile-actions">
        <div class="header__action">
          <UButton
            to="/favorites"
            icon="i-lucide-heart"
            variant="ghost"
            color="neutral"
            aria-label="Избранное"
          />
          <span v-if="favorites.count" class="header__count">
            {{ favorites.count }}
          </span>
        </div>

        <div class="header__action">
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
      </div>
    </UContainer>

    <UDrawer
      v-model:open="mobileOpen"
      direction="left"
      title="Меню"
      description="Навигация по магазину"
      :handle="false"
      close
      :ui="{
        content: 'w-[min(20rem,calc(100vw-0.5rem))] max-w-full',
        header: 'pt-[max(1rem,var(--safe-top))]',
        body: 'p-0',
      }"
    >
      <template #body>
        <nav class="mobile-nav" aria-label="Мобильная навигация">
          <NuxtLink to="/catalog" class="mobile-nav__link">
            <UIcon name="i-lucide-store" />
            <span>Каталог</span>
          </NuxtLink>

          <NuxtLink to="/delivery" class="mobile-nav__link">
            <UIcon name="i-lucide-truck" />
            <span>Доставка</span>
          </NuxtLink>

          <NuxtLink to="/favorites" class="mobile-nav__link">
            <UIcon name="i-lucide-heart" />
            <span>Избранное</span>
            <UBadge v-if="favorites.count" class="mobile-nav__count">
              {{ favorites.count }}
            </UBadge>
          </NuxtLink>

          <NuxtLink to="/cart" class="mobile-nav__link">
            <UIcon name="i-lucide-shopping-bag" />
            <span>Корзина</span>
            <UBadge v-if="cart.count" class="mobile-nav__count">
              {{ cart.count }}
            </UBadge>
          </NuxtLink>

          <NuxtLink to="/orders" class="mobile-nav__link">
            <UIcon name="i-lucide-package" />
            <span>Мои заказы</span>
          </NuxtLink>

          <NuxtLink
            v-if="auth.loggedIn"
            to="/profile"
            class="mobile-nav__link"
          >
            <UIcon name="i-lucide-user" />
            <span>Профиль</span>
          </NuxtLink>

          <button v-else type="button" class="mobile-nav__link" @click="login">
            <UIcon name="i-lucide-log-in" />
            <span>Войти</span>
          </button>

          <NuxtLink
            v-if="staff"
            to="/staff/orders"
            class="mobile-nav__link mobile-nav__link--staff"
          >
            <UIcon name="i-lucide-clipboard-list" />
            <span>Рабочее место продавца</span>
          </NuxtLink>
        </nav>
      </template>
    </UDrawer>

    <AuthModal v-model:open="loginOpen" />
  </header>
</template>

<script setup lang="ts">
import { useAuthStore } from "~/stores/auth";
import { useCartStore } from "~/stores/cart";
import { useFavoritesStore } from "~/stores/favorites";

const route = useRoute();
const auth = useAuthStore();
const cart = useCartStore();
const favorites = useFavoritesStore();
const loginOpen = ref(false);
const mobileOpen = ref(false);

const staff = computed(
  () => auth.user?.role === "SELLER" || auth.user?.role === "ADMIN",
);

watch(
  () => route.fullPath,
  () => {
    mobileOpen.value = false;
  },
);

function login() {
  mobileOpen.value = false;
  loginOpen.value = true;
}
</script>

<style scoped>
.header {
  border-bottom: 1px solid var(--ui-border);
}

.header__inner {
  display: flex;
  min-width: 0;
  min-height: var(--header-height);
  align-items: center;
  gap: 0.25rem;
}

.header__logo {
  min-width: 0;
  margin-right: auto;
  padding: 0.5rem;
  font-size: 1.125rem;
  font-weight: 700;
}

.header__menu,
.header__mobile-actions :deep(a),
.header__mobile-actions :deep(button) {
  min-width: var(--touch-target);
  min-height: var(--touch-target);
}

.header__nav,
.header__actions {
  display: none;
}

.header__mobile-actions {
  display: flex;
  flex: 0 0 auto;
  gap: 0.125rem;
}

.header__action {
  position: relative;
}

.header__count {
  position: absolute;
  top: 0;
  right: -0.125rem;
  display: grid;
  min-width: 1.125rem;
  height: 1.125rem;
  padding-inline: 0.25rem;
  place-items: center;
  border-radius: 999px;
  background: var(--ui-primary);
  color: white;
  font-size: 0.6875rem;
  font-weight: 700;
  line-height: 1;
  pointer-events: none;
}

.mobile-nav {
  display: grid;
  gap: 0.25rem;
  padding: 0.5rem max(var(--page-x), var(--safe-right))
    max(var(--page-x), var(--safe-bottom))
    max(var(--page-x), var(--safe-left));
}

.mobile-nav__link {
  display: grid;
  min-width: 0;
  min-height: var(--touch-target);
  grid-template-columns: 1.25rem minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem;
  border: 0;
  border-radius: 0.75rem;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  text-decoration: none;
  cursor: pointer;
}

.mobile-nav__link:hover,
.mobile-nav__link:focus-visible,
.mobile-nav__link.router-link-active {
  background: var(--ui-bg-elevated);
  color: var(--ui-primary);
}

.mobile-nav__link--staff {
  margin-top: 0.5rem;
  border-top: 1px solid var(--ui-border);
  border-radius: 0;
}

.mobile-nav__count {
  justify-self: end;
}

@media (min-width: 48rem) {
  .header__inner {
    gap: 2rem;
  }

  .header__logo {
    margin-right: 0;
    padding: 0;
    font-size: 1.25rem;
  }

  .header__menu,
  .header__mobile-actions {
    display: none;
  }

  .header__nav,
  .header__actions {
    display: flex;
    align-items: center;
  }

  .header__nav {
    gap: 1.5rem;
    margin-right: auto;
  }

  .header__actions {
    gap: 0.25rem;
  }

  /* .header__actions > *,
  .header__action > :deep(*) {
    min-width: var(--touch-target);
    min-height: var(--touch-target);
  } */
}
</style>
