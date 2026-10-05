<template>
  <div
    id="floating-cart-anchor"
    class="floating-cart-anchor"
    :class="{ 'floating-cart-anchor--visible': floatingCartVisible }"
  />
  <header class="header" :class="{ 'header--hidden': mobileHeaderHidden }">
    <UContainer class="header__inner" :inert="mobileHeaderHidden">
      <UButton
        class="header__menu"
        variant="ghost"
        color="neutral"
        :aria-label="mobileOpen ? 'Закрыть меню' : 'Открыть меню'"
        aria-haspopup="dialog"
        aria-controls="mobile-menu"
        :aria-expanded="mobileOpen"
        @click="mobileOpen = !mobileOpen"
      >
        <span class="header__burger" aria-hidden="true">
          <span class="header__burger-line" />
          <span class="header__burger-line" />
          <span class="header__burger-line" />
        </span>
      </UButton>

      <NuxtLink to="/" class="header__brand" aria-label="KorzinaMarket — на главную">
        <AppMarketLogo />
      </NuxtLink>

      <nav class="header__nav" aria-label="Основная навигация">
        <NuxtLink
          to="/catalog"
          class="header__nav-link"
          :class="{ 'header__nav-link--active': catalogActive }"
          :aria-current="catalogActive ? 'page' : undefined"
          aria-label="Каталог"
          title="Каталог"
        >
          <UIcon name="i-lucide-layout-grid" aria-hidden="true" />
        </NuxtLink>
        <NuxtLink
          to="/how-it-works"
          class="header__nav-link"
          :class="{ 'header__nav-link--active': deliveryActive }"
          :aria-current="deliveryActive ? 'page' : undefined"
          aria-label="Как это работает"
          title="Как это работает"
        >
          <UIcon name="i-lucide-truck" aria-hidden="true" />
        </NuxtLink>
        <a
          v-if="customerTelegramUrl"
          :href="customerTelegramUrl"
          class="header__nav-link"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Покупать в Telegram"
          title="Покупать в Telegram"
        >
          <UIcon name="i-lucide-send" aria-hidden="true" />
        </a>
        <div class="header__nav-theme"><AppThemeControl /></div>
        <UButton
          v-if="account.adminTo"
          :to="account.adminTo"
          class="header__admin-action"
          icon="i-lucide-settings"
          variant="ghost"
          color="neutral"
          aria-label="Админка"
          title="Админка"
        />
      </nav>

      <div class="header__actions">
        <UButton
          :to="account.to"
          class="header__profile"
          icon="i-lucide-user"
          variant="ghost"
          color="neutral"
          :aria-label="account.label"
          :title="account.label"
          @click="!account.to && login()"
        />
        <AppOrdersAction class="header__orders" :action="orders" />
        <div class="header__action header__action--favorites">
          <UButton
            to="/favorites"
            class="header__favorites"
            variant="ghost"
            color="neutral"
            aria-label="Избранное"
            title="Избранное"
          >
            <svg class="header__favorite-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M2 9.5a5.5 5.5 0 0 1 9.591-3.676a.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5" />
            </svg>
          </UButton>
          <span v-if="favorites.count" class="header__count">{{ favorites.count }}</span>
          <AppHeaderNotice target="favorites" />
        </div>
        <Teleport to="#floating-cart-anchor" :disabled="!floatingCartVisible">
          <div class="header__action header__action--cart" :class="{ 'header__action--floating': floatingCartVisible }">
            <NuxtLink
              to="/cart"
              class="cart-control"
              :aria-label="cartLabel"
              :title="cartLabel"
              :aria-busy="cart.count > 0 && !cart.quoteReady ? true : undefined"
            >
              <span
                v-if="cart.count"
                class="cart-control__amount"
                :class="{ 'cart-control__amount--stale': !cart.quoteReady }"
                aria-hidden="true"
              >
                <span
                  :key="`${cart.displayTotal ?? 'pending'}-${cart.quoteReady}`"
                  class="cart-control__amount-value"
                >{{ cart.displayTotal !== null ? (!cart.quoteReady ? '≈ ' : '') + money(cart.displayTotal) : '…' }}</span>
              </span>
              <span class="cart-control__scene">
                <AppBasketScene v-if="cart.restored" :key="sceneKey" :state="sceneState" />
              </span>
            </NuxtLink>
            <AppHeaderNotice target="cart" :floating="floatingCartVisible" />
          </div>
        </Teleport>
      </div>
    </UContainer>

    <UDrawer
      v-model:open="mobileOpen"
      :should-scale-background="false"
      :no-body-styles="true"
      direction="left"
      title="Меню"
      inset
      :handle="false"
      close
      :ui="{
        overlay: 'bg-black/35',
        content:
          '[--initial-transform:calc(100%_+_max(0.5rem,var(--safe-left)))] inset-y-auto top-[max(0.5rem,var(--safe-top))] left-[max(0.5rem,var(--safe-left))] h-auto max-h-[calc(100dvh_-_max(0.5rem,var(--safe-top))_-_max(0.5rem,var(--safe-bottom)))] w-[min(20rem,calc(100vw_-_max(0.5rem,var(--safe-left))_-_max(0.5rem,var(--safe-right))))] max-w-none rounded-[1.25rem] overflow-hidden border border-default bg-default shadow-xl ring-0',
        container: 'min-h-0 max-h-[inherit] gap-0 overflow-hidden p-0',
        header: 'min-h-16 shrink-0 px-4 py-2',
        body: 'min-h-0 flex-auto overflow-y-auto overscroll-contain p-2 pt-0',
        close: 'min-h-11 min-w-11 justify-center',
      }"
    >
      <template #body>
        <nav
          id="mobile-menu"
          class="mobile-nav"
          aria-label="Мобильная навигация"
          @click="closeMenuLink"
          @keydown.esc="mobileOpen = false"
        >
          <div class="mobile-nav__group">
            <NuxtLink to="/catalog" class="mobile-nav__link">
              <UIcon name="i-lucide-layout-grid" />
              <span>Каталог</span>
            </NuxtLink>

            <NuxtLink to="/how-it-works" class="mobile-nav__link">
              <UIcon name="i-lucide-truck" />
              <span>Как это работает</span>
            </NuxtLink>

            <a
              v-if="customerTelegramUrl"
              :href="customerTelegramUrl"
              class="mobile-nav__link"
              target="_blank"
              rel="noopener noreferrer"
            >
              <UIcon name="i-lucide-send" />
              <span>Покупать в Telegram</span>
            </a>

            <NuxtLink to="/favorites" class="mobile-nav__link">
              <svg class="mobile-nav__favorite-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M2 9.5a5.5 5.5 0 0 1 9.591-3.676a.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5" />
              </svg>
              <span>Избранное</span>
              <UBadge v-if="favorites.count" class="mobile-nav__count">
                {{ favorites.count }}
              </UBadge>
            </NuxtLink>

            <NuxtLink
              to="/cart"
              class="mobile-nav__link"
              :aria-label="cartLabel"
            >
              <UIcon name="i-lucide-shopping-cart" />
              <span>Корзина</span>
              <span
                v-if="cart.count"
                class="mobile-nav__amount"
                :class="{ 'mobile-nav__amount--stale': !cart.quoteReady }"
              >
                {{
                  cart.displayTotal !== null ? money(cart.displayTotal) : "…"
                }}
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

            <NuxtLink
              v-if="auth.loggedIn"
              to="/profile"
              class="mobile-nav__link"
            >
              <UIcon name="i-lucide-user" />
              <span>Профиль</span>
            </NuxtLink>

            <button
              v-else
              type="button"
              class="mobile-nav__link"
              @click="login"
            >
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
  <div class="header-spacer" aria-hidden="true" />

  <span class="sr-only" role="status" aria-live="polite" aria-atomic="true">{{ notice.current?.text ?? "" }}</span>
</template>

<script setup lang="ts">
import { useAuthStore } from "~/stores/auth";
import { useCartStore } from "~/stores/cart";
import { useFavoritesStore } from "~/stores/favorites";
import { headerAccount } from "~/utils/header-account";
import { money } from "~/utils/money";
import { customerBotUrl } from "~/utils/customer-bot-url";
import { createHeaderScroll, mobileLandscapeQuery } from "~/utils/header-scroll";

const route = useRoute();
const customerTelegramUrl = computed(() =>
  customerBotUrl(useRuntimeConfig().public.telegramCustomerBotUrl),
);
const auth = useAuthStore();
const orders = useOrdersAction();
const cart = useCartStore();
const favorites = useFavoritesStore();
const { sceneKey, sceneState } = useBasketScene();
const catalogActive = computed(() =>
  route.path.startsWith("/catalog") || route.path.startsWith("/product/"),
);
const deliveryActive = computed(() => ["/how-it-works", "/delivery"].includes(route.path));
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
const staff = computed(
  () => auth.user?.role === "SELLER" || auth.user?.role === "ADMIN",
);

const narrow = ref(false);
const landscape = ref(false);
const scrolled = ref(false);
const mobileHeaderHidden = computed(
  () => narrow.value && (landscape.value || (scrolled.value && notice.current?.target !== "favorites")) &&
    !mobileOpen.value && !loginOpen.value,
);
const floatingCartVisible = computed(
  () => mobileHeaderHidden.value && (cart.count > 0 || notice.current?.target === "cart"),
);

let stopScroll = () => {};
onMounted(() => {
  const media = window.matchMedia("(width < 768px)");
  const landscapeMedia = window.matchMedia(mobileLandscapeQuery);
  const scroll = createHeaderScroll();
  let frame = 0;

  function syncScroll() {
    if (!narrow.value) {
      scrolled.value = false;
    } else scrolled.value = scroll.sample(window.scrollY);
  }

  function onScroll() {
    if (!narrow.value || frame) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      syncScroll();
    });
  }

  function syncWidth() {
    landscape.value = landscapeMedia.matches;
    narrow.value = media.matches || landscape.value;
    scrolled.value = scroll.reset(window.scrollY);
    syncScroll();
  }

  syncWidth();
  window.addEventListener("scroll", onScroll, { passive: true });
  media.addEventListener("change", syncWidth);
  landscapeMedia.addEventListener("change", syncWidth);
  const stopWatch = watch([() => route.path, mobileOpen, loginOpen], syncScroll);
  stopScroll = () => {
    window.removeEventListener("scroll", onScroll);
    media.removeEventListener("change", syncWidth);
    landscapeMedia.removeEventListener("change", syncWidth);
    window.cancelAnimationFrame(frame);
    stopWatch();
  };
});
onBeforeUnmount(() => stopScroll());

watch(() => route.fullPath, () => {
  mobileOpen.value = false;
  notice.clear();
});

function login() {
  mobileOpen.value = false;
  loginOpen.value = true;
}

function closeMenuLink(event: MouseEvent) {
  if (event.target instanceof Element && event.target.closest("a"))
    mobileOpen.value = false;
}
</script>

<style scoped>
.header-spacer { display: none; }
.header {
  position: sticky;
  top: 0;
  z-index: 30;
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-bg);
}

.header__inner {
  display: flex;
  min-width: 0;
  min-height: var(--header-height);
  align-items: center;
  gap: 0;
}

.header__brand {
  display: flex;
  min-width: 44px;
  min-height: 44px;
  flex: 0 0 auto;
  align-items: center;
  border-radius: 0.5rem;
}

.header__brand:focus-visible,
.header__nav-link:focus-visible,
.cart-control:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: 2px;
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
  display: flex;
  width: 1.25rem;
  height: 1rem;
  flex: none;
  flex-direction: column;
  justify-content: space-between;
}

.header__burger-line {
  display: block;
  width: 100%;
  height: 2px;
  border-radius: 999px;
  background: currentColor;
  transition: transform 180ms ease, opacity 180ms ease;
}

.header__menu[aria-expanded="true"] .header__burger-line:first-child {
  transform: translateY(7px) rotate(45deg);
}

.header__menu[aria-expanded="true"] .header__burger-line:nth-child(2) {
  opacity: 0;
}

.header__menu[aria-expanded="true"] .header__burger-line:last-child {
  transform: translateY(-7px) rotate(-45deg);
}

.header__nav {
  display: none;
}

.header__actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  margin-left: auto;
  gap: 0.25rem;
}

.header__profile,
.header__orders,
.header__favorites,
.header__action--favorites .header__count {
  display: none;
}

/* Keep the favorites notice mounted beside the cart when its icon moves to the drawer. */
.header__action--favorites {
  width: 0;
}

.header__orders :deep(.orders-action__label) {
  display: none;
}

.header__action {
  position: relative;
  flex: none;
}

.header__favorites {
  padding: 0;
}

.header__favorites:hover {
  background: rgb(225 29 72 / 10%);
}

.header__profile.router-link-active,
.header__orders :deep(.orders-action__button.router-link-active),
.header__favorites.router-link-active,
.cart-control.router-link-active,
.header__admin-action.router-link-active {
  background: color-mix(in srgb, var(--ui-primary) 12%, transparent);
  color: var(--ui-primary);
}

.header__favorites:focus-visible {
  outline: 2px solid #be123c;
  outline-offset: 2px;
}

.header__favorite-icon,
.mobile-nav__favorite-icon {
  width: 1.25rem;
  height: 1.25rem;
  flex: none;
  color: #e11d48;
  fill: currentColor;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
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

.cart-control {
  display: inline-flex;
  min-width: var(--touch-target);
  min-height: 3rem;
  flex: none;
  flex-direction: row;
  align-items: center;
  justify-content: flex-end;
  gap: 0.375rem;
  padding: 0.125rem;
  border-radius: 0.75rem;
  color: var(--ui-text);
  text-decoration: none;
}

.cart-control:hover {
  background: var(--ui-bg-elevated);
}

.cart-control__scene {
  display: block;
  width: 2.5rem;
  height: 2.5rem;
  flex: none;
}

.cart-control__amount {
  display: inline-flex;
  min-height: 1.75rem;
  flex: none;
  align-items: center;
  justify-content: center;
  padding: 0.125rem 0.25rem;
  border: 1px solid color-mix(in srgb, var(--ui-success) 18%, transparent);
  border-radius: 0.5rem;
  background: color-mix(in srgb, var(--ui-success) 12%, transparent);
  color: var(--ui-text-highlighted);
  font-size: clamp(0.8125rem, calc(0.75rem + 0.2vw), 0.875rem);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  white-space: nowrap;
}

.cart-control__amount-value {
  display: inline-block;
  white-space: nowrap;
  animation: cart-control-refresh 180ms ease-out;
}

.cart-control__amount--stale {
  border-color: color-mix(in srgb, var(--ui-success) 12%, transparent);
  background: color-mix(in srgb, var(--ui-success) 6%, transparent);
  color: var(--ui-text-muted);
}

.mobile-nav__amount--stale {
  color: var(--ui-text-muted);
}

@keyframes cart-control-refresh {
  from { opacity: 0.65; transform: translateY(2px); }
  to { opacity: 1; transform: translateY(0); }
}

.mobile-nav__amount {
  max-width: 8rem;
  text-align: right;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.floating-cart-anchor {
  position: fixed;
  top: max(0.5rem, env(safe-area-inset-top, 0px));
  right: max(0.5rem, env(safe-area-inset-right, 0px));
  z-index: 31;
  max-width: calc(100vw - max(0.5rem, env(safe-area-inset-left, 0px)) - max(0.5rem, env(safe-area-inset-right, 0px)));
  pointer-events: none;
}

.floating-cart-anchor--visible .header__action {
  pointer-events: auto;
}

.header__action--floating .cart-control {
  min-height: 3.25rem;
  padding: 0.25rem 0.5rem;
  border: 1px solid var(--ui-border);
  border-radius: 1rem;
  background: var(--ui-bg);
  box-shadow: 0 4px 16px rgb(0 0 0 / 15%);
}

@media (width < 768px) {
  .header {
    position: fixed;
    width: 100%;
    padding-top: env(safe-area-inset-top, 0px);
    transition: transform 180ms ease;
  }
  .header-spacer { display: block; height: calc(var(--header-height) + env(safe-area-inset-top, 0px)); }

  .header--hidden {
    transform: translateY(-100%);
  }
}

@media (min-width: 24rem) {
  .header__orders {
    display: block;
  }
}

@media (min-width: 28rem) {
  .header__action--favorites {
    width: auto;
  }

  .header__favorites {
    display: inline-flex;
  }

  .header__action--favorites .header__count {
    display: grid;
  }
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
  .header__inner {
    gap: clamp(0.25rem, 0.8vw, 0.75rem);
  }

  .header__menu {
    display: none;
  }

  .header__nav {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 0.125rem;
  }

  .header__nav-link {
    display: inline-flex;
    width: 44px;
    min-width: 44px;
    min-height: 44px;
    align-items: center;
    justify-content: center;
    border-radius: 0.5rem;
    color: var(--ui-text);
  }

  .header__nav-link:hover,
  .header__nav-link--active {
    background: var(--ui-bg-elevated);
    color: var(--ui-primary);
  }

  .header__nav-link > :first-child {
    width: 1.25rem;
    height: 1.25rem;
  }

  .header__nav-theme {
    flex: none;
  }

  .header__admin-action {
    min-width: 44px;
    min-height: 44px;
  }

  .header__profile {
    display: inline-flex;
  }

  .cart-control {
    min-height: 44px;
    padding-inline: 0.375rem;
  }

  .floating-cart-anchor {
    display: none;
  }
}

@media (orientation: landscape) and (max-height: 500px) and (max-width: 1024px) and (pointer: coarse) {
  .header { position: fixed; width: 100%; transform: translateY(-100%); }
  .header-spacer { display: none; }
  .floating-cart-anchor { display: block; }
}

@media (prefers-reduced-motion: reduce) {
  .header,
  .header__burger-line,
  .cart-control__amount-value {
    transition: none;
    animation: none;
  }
}
</style>
