<template>
  <header
    class="header"
    :class="{ 'header--hidden': mobileHeaderHidden }"
  >
    <UContainer class="header__inner" :inert="mobileHeaderHidden">
      <UButton
        class="header__menu"
        variant="ghost"
        color="neutral"
        :aria-label="mobileOpen ? 'Закрыть меню' : 'Открыть меню'"
        aria-haspopup="dialog"
        :aria-expanded="mobileOpen"
        @click="mobileOpen = !mobileOpen"
      >
        <span class="header__burger" aria-hidden="true" />
      </UButton>
      <NuxtLink
        to="/"
        class="header__brand"
        aria-label="KorzinaMarket — на главную"
      >
        <AppMarketLogo />
      </NuxtLink>

      <nav class="header__nav" aria-label="Основная навигация">
        <NuxtLink to="/catalog">Каталог</NuxtLink>
        <NuxtLink to="/delivery">Доставка</NuxtLink>
      </nav>

      <div class="header__actions">
        <div class="header__secondary">
          <AppThemeControl />
        </div>
        <UButton
          v-if="account.adminTo"
          :to="account.adminTo"
          icon="i-lucide-settings"
          variant="ghost"
          color="neutral"
          aria-label="Админка"
          title="Админка"
        >
          <span class="header__admin-label">Админка</span>
        </UButton>

        <UButton
          :to="account.to"
          icon="i-lucide-user"
          variant="ghost"
          color="neutral"
          :aria-label="account.label"
          :title="account.label"
          @click="!account.to && login()"
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
          <AppHeaderNotice target="favorites" />
        </div>

        <div class="header__action">
          <UButton
            to="/cart"
            icon="i-lucide-shopping-basket"
            variant="ghost"
            color="neutral"
            class="header__cart"
            :aria-label="cartLabel"
            :title="cartLabel"
          >
            <span
              v-if="cart.count"
              class="header__amount"
              :class="{ 'header__amount--stale': !cart.quoteReady }"
              >{{
                cart.displayTotal !== null ? money(cart.displayTotal) : "…"
              }}</span
            >
          </UButton>
          <AppHeaderNotice target="cart" />
        </div>

        <AppOrdersAction class="header__secondary" :action="orders" />
      </div>
    </UContainer>

    <UDrawer
      v-model:open="mobileOpen"
      :should-scale-background="false"
      direction="left"
      title="Меню"
      inset
      :handle="false"
      close
      :ui="{
        overlay: 'bg-black/35 backdrop-blur-[2px]',
        content: '[--initial-transform:calc(100%_+_max(0.5rem,var(--safe-left)))] inset-y-auto top-[max(0.5rem,var(--safe-top))] left-[max(0.5rem,var(--safe-left))] h-auto max-h-[calc(100dvh_-_max(0.5rem,var(--safe-top))_-_max(0.5rem,var(--safe-bottom)))] w-[min(20rem,calc(100vw_-_max(0.5rem,var(--safe-left))_-_max(0.5rem,var(--safe-right))))] max-w-none rounded-[1.25rem] overflow-hidden border border-default bg-default shadow-xl ring-0',
        container: 'min-h-0 max-h-[inherit] gap-0 overflow-hidden p-0',
        header: 'min-h-16 shrink-0 px-4 py-2',
        body: 'min-h-0 flex-auto overflow-y-auto overscroll-contain p-2 pt-0',
        close: 'min-h-11 min-w-11 justify-center',
      }"
    >
      <template #body>
        <nav class="mobile-nav" aria-label="Мобильная навигация">
          <div class="mobile-nav__group">
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

            <NuxtLink to="/cart" class="mobile-nav__link" :aria-label="cartLabel">
              <UIcon name="i-lucide-shopping-basket" />
              <span>Корзина</span>
              <span
                v-if="cart.count"
                class="mobile-nav__amount"
                :class="{ 'mobile-nav__amount--stale': !cart.quoteReady }"
              >
                {{ cart.displayTotal !== null ? money(cart.displayTotal) : "…" }}
              </span>
            </NuxtLink>
          </div>

          <div class="mobile-nav__group">
            <NuxtLink
              :to="orders.to"
              class="mobile-nav__link mobile-nav__link--orders"
              :aria-label="orders.label"
            >
              <UIcon name="i-lucide-package" />
              <span>{{ staff ? "Заказы" : "Мои заказы" }}</span>
              <span class="mobile-nav__badges">
                <AppAttentionBadge
                  :count="orders.newOrdersCount"
                  variant="success"
                />
                <AppAttentionBadge
                  :count="orders.unreadMessagesCount"
                  variant="info"
                />
              </span>
            </NuxtLink>

            <NuxtLink v-if="auth.loggedIn" to="/profile" class="mobile-nav__link">
              <UIcon name="i-lucide-user" />
              <span>Профиль</span>
            </NuxtLink>

            <button v-else type="button" class="mobile-nav__link" @click="login">
              <UIcon name="i-lucide-log-in" />
              <span>Войти</span>
            </button>
          </div>

          <div v-if="staff" class="mobile-nav__group">
            <NuxtLink
              v-if="auth.user?.role === 'ADMIN'"
              to="/admin/products"
              class="mobile-nav__link"
              ><UIcon name="i-lucide-settings" /><span>Админка</span></NuxtLink
            >

            <NuxtLink
              v-if="staff"
              to="/staff/orders"
              class="mobile-nav__link mobile-nav__link--staff"
            >
              <UIcon name="i-lucide-clipboard-list" />
              <span>Рабочее место продавца</span>
            </NuxtLink>
          </div>

          <div class="mobile-nav__group">
            <div class="mobile-nav__theme">
              <UIcon name="i-lucide-sun-moon" aria-hidden="true" />
              <span>Тема</span>
              <AppThemeControl />
            </div>
          </div>
        </nav>
      </template>
    </UDrawer>

    <AuthModal v-model:open="loginOpen" />
  </header>

  <Transition name="floating-cart">
    <UButton
      v-if="mobileHeaderHidden && cart.count"
      to="/cart"
      icon="i-lucide-shopping-basket"
      variant="ghost"
      color="neutral"
      class="floating-cart"
      :aria-label="cartLabel"
      :title="cartLabel"
    >
      <span
        class="floating-cart__amount"
        :class="{ 'floating-cart__amount--stale': !cart.quoteReady }"
      >
        {{ cart.displayTotal !== null ? money(cart.displayTotal) : "…" }}
      </span>
    </UButton>
  </Transition>
</template>

<script setup lang="ts">
import { useAuthStore } from "~/stores/auth";
import { useCartStore } from "~/stores/cart";
import { useFavoritesStore } from "~/stores/favorites";
import { headerAccount } from "~/utils/header-account";
import { money } from "~/utils/money";

const route = useRoute();
const auth = useAuthStore();
const orders = useOrdersAction();
const cart = useCartStore();
const favorites = useFavoritesStore();
const cartLabel = computed(() =>
  !cart.count
    ? "Корзина"
    : cart.displayTotal !== null
      ? (cart.quoteReady
          ? "Корзина. Предварительная сумма товаров "
          : "Корзина. Последний расчёт, сумма уточняется: ") +
        money(cart.displayTotal)
      : cart.quoteReady
        ? "Корзина. Проверьте товары"
        : "Корзина. Сумма рассчитывается",
);
const notice = useHeaderNotice();
onBeforeUnmount(notice.clear);
watch(() => auth.user?.id, notice.clear);
const loginOpen = ref(false);
const mobileOpen = ref(false);
const account = computed(() => headerAccount(auth.user));
const catalogRoute = computed(
  () => route.path === "/catalog" || route.path.startsWith("/catalog/"),
);
const narrow = ref(false);
const scrolled = ref(false);
const mobileHeaderHidden = computed(
  () => catalogRoute.value && narrow.value && scrolled.value
    && !mobileOpen.value && !loginOpen.value,
);
let stopScroll = () => {};

onMounted(() => {
  const media = window.matchMedia("(width < 768px)");
  let frame = 0;

  function syncScroll() {
    if (!catalogRoute.value || !narrow.value) {
      scrolled.value = false;
    } else if (window.scrollY <= 24) {
      scrolled.value = false;
    } else if (window.scrollY >= 72) {
      scrolled.value = true;
    }
  }

  function onScroll() {
    if (!catalogRoute.value || !narrow.value || frame) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      syncScroll();
    });
  }

  function syncWidth() {
    narrow.value = media.matches;
    syncScroll();
  }

  syncWidth();
  window.addEventListener("scroll", onScroll, { passive: true });
  media.addEventListener("change", syncWidth);
  const stopWatch = watch([() => route.path, mobileOpen, loginOpen], syncScroll);
  stopScroll = () => {
    window.removeEventListener("scroll", onScroll);
    media.removeEventListener("change", syncWidth);
    window.cancelAnimationFrame(frame);
    stopWatch();
  };
});
onBeforeUnmount(() => stopScroll());

const staff = computed(
  () => auth.user?.role === "SELLER" || auth.user?.role === "ADMIN",
);

watch(
  () => route.fullPath,
  () => {
    mobileOpen.value = false;
    notice.clear();
  },
);

function login() {
  mobileOpen.value = false;
  loginOpen.value = true;
}
</script>

<style scoped>
.header {
  position: sticky;
  top: 0;
  z-index: 30;
  background: var(--ui-bg);
  border-bottom: 1px solid var(--ui-border);
}

.floating-cart {
  position: fixed;
  top: max(0.5rem, env(safe-area-inset-top, 0px));
  right: max(0.5rem, env(safe-area-inset-right, 0px));
  z-index: 30;
  min-width: 44px;
  min-height: 44px;
  max-width: calc(100vw - max(0.5rem, env(safe-area-inset-left, 0px)) - max(0.5rem, env(safe-area-inset-right, 0px)));
  gap: 0.5rem;
  padding: 0.625rem 0.875rem;
  border: 1px solid var(--ui-border);
  border-radius: 999px;
  background: var(--ui-bg);
  color: var(--ui-text);
  box-shadow: 0 4px 16px rgb(0 0 0 / 15%);
}

.floating-cart:hover {
  background: var(--ui-bg-elevated);
}

.floating-cart:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: 2px;
}

.floating-cart__amount {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.floating-cart__amount--stale {
  color: var(--ui-text-muted);
}

.floating-cart-enter-active {
  transition: opacity 180ms ease 180ms, transform 180ms ease 180ms;
}

.floating-cart-enter-from {
  opacity: 0;
  transform: translateY(-0.25rem);
}

/* Remove the floating control immediately when the header returns. */
.floating-cart-leave-active {
  display: none;
}

@media (width < 768px) {
  .header {
    transition: transform 180ms ease;
  }

  .header--hidden {
    transform: translateY(-100%);
  }
}

@media (min-width: 768px) {
  .floating-cart {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .header,
  .floating-cart-enter-active {
    transition: none;
  }
}

.header__inner {
  display: flex;
  min-width: 0;
  min-height: var(--header-height);
  align-items: center;
  gap: 0.25rem;
}

.header__brand {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  min-width: 44px;
  min-height: 44px;
  margin-right: auto;
  border-radius: 0.5rem;
}
.header__brand:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: 3px;
}

.header__menu,
.header__actions :deep(a),
.header__actions :deep(button) {
  min-width: var(--touch-target);
  min-height: var(--touch-target);
  flex-shrink: 0;
  justify-content: center;
}

.header__burger {
  position: relative;
  display: block;
  width: 1.25rem;
  height: 1rem;
  flex: none;
}

.header__burger::before,
.header__burger::after {
  content: "";
  position: absolute;
  left: 0;
  height: 2px;
  border-radius: 999px;
  background: currentColor;
  transition: transform 180ms ease, width 180ms ease;
}

.header__burger::before {
  top: 4px;
  width: 100%;
}

.header__burger::after {
  bottom: 4px;
  width: 70%;
}

.header__menu[aria-expanded="true"] .header__burger::before {
  transform: translateY(3px) rotate(45deg);
}

.header__menu[aria-expanded="true"] .header__burger::after {
  width: 100%;
  transform: translateY(-3px) rotate(-45deg);
}

@media (prefers-reduced-motion: reduce) {
  .header__burger::before,
  .header__burger::after {
    transition: none;
  }
}

.header__nav,
.header__secondary,
.header__admin-label {
  display: none;
}

.header__actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 0.125rem;
}

.header__action {
  position: relative;
}

.header__cart {
  flex-direction: column;
  width: clamp(2.75rem, calc(100vw - 17rem), 6rem);
  gap: 0.125rem;
  padding-inline: 0.125rem;
}

.header__amount {
  max-width: 100%;
  font-size: 0.75rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
  overflow-wrap: anywhere;
  white-space: normal;
}

.header__amount--stale,
.mobile-nav__amount--stale {
  color: var(--ui-text-muted);
}

.mobile-nav__amount {
  max-width: 8rem;
  text-align: right;
  font-weight: 600;
  overflow-wrap: anywhere;
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
  color: var(--ui-text-inverted);
  font-size: 0.6875rem;
  font-weight: 700;
  line-height: 1;
  pointer-events: none;
}

.mobile-nav {
  display: grid;
  min-width: 0;
}

.mobile-nav__group {
  display: grid;
  min-width: 0;
  gap: 0.25rem;
}

.mobile-nav__group + .mobile-nav__group {
  margin-top: 0.5rem;
  padding-top: 0.5rem;
  border-top: 1px solid var(--ui-border);
}

.mobile-nav__link,
.mobile-nav__theme {
  display: grid;
  width: 100%;
  min-width: 0;
  min-height: 3rem;
  grid-template-columns: 1.25rem minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.75rem;
  padding: 0.375rem 0.75rem;
  border: 0;
  border-radius: 0.75rem;
  background: transparent;
  color: inherit;
  font: inherit;
  line-height: 1.25;
  text-align: left;
  text-decoration: none;
  overflow-wrap: anywhere;
}

.mobile-nav__link {
  cursor: pointer;
}

.mobile-nav__link > :first-child,
.mobile-nav__theme > :first-child {
  width: 1.25rem;
  height: 1.25rem;
}

.mobile-nav__link:hover {
  background: var(--ui-bg-elevated);
}

.mobile-nav__link:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: -2px;
}

.mobile-nav__link.router-link-active {
  background: color-mix(in srgb, var(--ui-primary) 12%, transparent);
  color: var(--ui-primary);
}

.mobile-nav__count {
  justify-self: end;
}

.mobile-nav__badges {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}

.mobile-nav__badges :deep(.attention-badge) {
  position: static;
  flex: none;
}

.mobile-nav__theme {
  padding-block: 0.25rem;
}

@media (min-width: 48rem) {
  .header__secondary {
    display: flex;
  }
}

@media (min-width: 48rem) {
  .header__cart {
    flex-direction: row;
    width: auto;
    max-width: 12rem;
    gap: 0.5rem;
    padding-inline: 0.5rem;
  }

  .header__amount {
    font-size: 0.875rem;
  }

  .header__inner {
    gap: 1rem;
  }

  .header__brand {
    margin-right: 0;
  }

  .header__menu {
    display: none;
  }

  .header__nav {
    display: flex;
    align-items: center;
  }

  .header__nav {
    gap: 1.5rem;
    margin-right: auto;
  }

  .header__nav > a {
    display: inline-flex;
    align-items: center;
    min-height: var(--touch-target);
  }

  .header__actions {
    gap: 0.25rem;
  }
}
@media (min-width: 64rem) {
  .header__inner {
    gap: 2rem;
  }

  .header__admin-label {
    display: inline;
  }
}
</style>
