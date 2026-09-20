<template>
  <article class="card" :class="{ 'card--added': action.added }">
    <div class="card__media">
      <NuxtLink :to="`/product/${product.slug}`" class="card__img">
        <img
          v-if="product.images[0]"
          :src="asset(product.images[0].url)"
          :alt="product.images[0].alt || product.name"
        />
        <span v-else> Фото скоро </span>
      </NuxtLink>

      <span
        v-if="action.added"
        class="card__quantity"
        role="status"
        aria-live="polite"
      >
        <span class="sr-only">В корзине: </span>{{ quantityLabel }}
      </span>
      <ProductFavorite class="card__favorite" :product="product" />
    </div>

    <div class="card__body">
      <NuxtLink
        :to="`/catalog/${product.category.slug}`"
        class="card__category"
      >
        {{ product.category.name }}
      </NuxtLink>

      <NuxtLink :to="`/product/${product.slug}`" class="card__link">
        <h3 class="card__title">
          {{ product.name }}
        </h3>
      </NuxtLink>

      <div class="card__bottom">
        <ProductPrice :product="product" />

        <UButton
          v-if="!action.added"
          class="card__add"
          :aria-label="action.ariaLabel"
          :disabled="!cart.restored"
          @click="add"
        >
          <span class="card__add-label">{{ action.label }}</span>
          <UIcon
            name="i-lucide-plus"
            class="card__add-icon"
            aria-hidden="true"
          />
        </UButton>
        <div
          v-else
          class="card__control"
          role="group"
          :aria-label="product.name + ': в корзине ' + action.label"
        >
          <UButton
            icon="i-lucide-minus"
            variant="ghost"
            color="neutral"
            class="card__portion"
            :aria-label="'Уменьшить на ' + portion + ': ' + product.name"
            :disabled="previousCartQty(cartQty, cartProduct) === null"
            @click="subtract"
          />
          <span
            class="card__total"
            :class="{ 'card__total--stale': !cart.quoteReady }"
            :title="totalLabel"
            :aria-label="totalLabel"
          >
            {{ lineTotal !== null ? money(lineTotal) : "…" }}
          </span>
          <UButton
            icon="i-lucide-plus"
            variant="ghost"
            color="neutral"
            class="card__portion"
            :aria-label="action.ariaLabel"
            :disabled="nextCartQty(cartQty, cartProduct) === null"
            @click="add"
          />
        </div>
      </div>
    </div>
  </article>
</template>

<script setup lang="ts">
import type { ProductListItem } from "~/types/product";
import { useCartStore } from "~/stores/cart";
import { quickAddState } from "~/utils/quick-add";
import { nextCartQty, previousCartQty } from "~/utils/cart";
import { qtyText } from "~/utils/qty";
import { money } from "~/utils/money";

const { product } = defineProps<{
  product: ProductListItem;
}>();

const cart = useCartStore();
const asset = useAsset();
const notice = useHeaderNotice();
const cartQty = computed(() => cart.qty(product.id));
const cartProduct = computed(
  () =>
    cart.items.find((item) => item.product.id === product.id)?.product ??
    product,
);
const quantityLabel = computed(() =>
  qtyText(cartProduct.value.unit, cartQty.value),
);
const action = computed(() => quickAddState(cartProduct.value, cartQty.value));
const portion = computed(() =>
  qtyText(cartProduct.value.unit, cartProduct.value.portionQty),
);
const lineTotal = computed(() => cart.displayLineTotal(product.id));
const totalLabel = computed(() =>
  lineTotal.value !== null
    ? (cart.quoteReady
        ? "Стоимость позиции: "
        : "Последний расчёт позиции, сумма уточняется: ") +
      money(lineTotal.value)
    : cart.quoteReady
      ? "Проверьте позицию в корзине"
      : "Стоимость позиции рассчитывается",
);

function add() {
  const added = cart.add(cartProduct.value);
  notice.show({
    target: "cart",
    text: added
      ? "Добавлено в корзину"
      : "Проверьте количество и лимит позиций в корзине",
  });
}
function subtract() {
  const changed = cart.subtract(cartProduct.value);
  notice.show({
    target: "cart",
    text: changed
      ? cart.qty(product.id)
        ? "Количество уменьшено"
        : "Удалено из корзины"
      : "Проверьте количество в корзине",
  });
}
</script>

<style scoped>
.card {
  --card-inset: clamp(0.375rem, 0.25rem + 0.4vw, 0.5rem);

  display: flex;
  min-width: 0;
  flex-direction: column;
  overflow: hidden;

  border: 1px solid var(--ui-border);
  border-radius: 0.75rem;

  background: var(--ui-bg);
}

/* Когда товар уже в корзине */
.card--added {
  border-color: color-mix(in srgb, var(--ui-primary) 35%, var(--ui-border));
}

/* =========================================================
   IMAGE
   ========================================================= */

.card__media {
  position: relative;
  flex: none;
  overflow: hidden;

  background: #fff;
}

.card__img {
  position: relative;
  isolation: isolate;

  display: grid;
  width: 100%;

  aspect-ratio: 1 / 1;

  place-items: center;
  overflow: hidden;

  background: #fff;
  color: var(--color-neutral-600);
}

.card__img img {
  position: absolute;
  inset: 0;
  z-index: 0;

  width: 100%;
  height: 100%;

  object-fit: contain;
  object-position: center;

  transition:
    opacity 0.2s ease,
    filter 0.2s ease,
    transform 0.2s ease;
}

/*
  Товар в корзине:
  вместо grayscale оставляем продукт цветным,
  лишь немного приглушаем его.
*/
.card--added .card__img img {
  opacity: 0.9;
  filter: saturate(0.88) brightness(0.94) contrast(0.96);
}

/*
  Эффект плетёной корзины.
  Накладывается ТОЛЬКО поверх фотографии.
*/
.card--added .card__img::after {
  content: "";

  position: absolute;
  inset: 0;
  z-index: 1;

  pointer-events: none;

  background:
    repeating-linear-gradient(
      0deg,
      transparent 0,
      transparent 7px,
      rgba(105, 66, 31, 0.13) 7px,
      rgba(105, 66, 31, 0.13) 9px,
      rgba(207, 158, 96, 0.2) 9px,
      rgba(207, 158, 96, 0.2) 12px,
      transparent 12px,
      transparent 16px
    ),
    repeating-linear-gradient(
      90deg,
      transparent 0,
      transparent 8px,
      rgba(181, 128, 68, 0.16) 8px,
      rgba(181, 128, 68, 0.16) 11px,
      rgba(101, 63, 30, 0.11) 11px,
      rgba(101, 63, 30, 0.11) 14px,
      transparent 14px,
      transparent 19px
    ),
    linear-gradient(rgba(171, 119, 61, 0.04), rgba(116, 75, 34, 0.08));

  mix-blend-mode: multiply;
  opacity: 0.58;
}

/* =========================================================
   QUANTITY BADGE
   ========================================================= */

.card__quantity {
  position: absolute;

  top: 50%;
  left: 50%;
  z-index: 3;

  transform: translate(-50%, -50%);

  width: max-content;
  max-width: calc(100% - 0.75rem);

  padding: clamp(0.2rem, 0.15rem + 0.15vw, 0.3rem)
    clamp(0.4rem, 0.3rem + 0.25vw, 0.6rem);

  overflow: hidden;

  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 0.55rem;

  background: rgba(15, 27, 49, 0.92);
  color: #fff;

  font-size: clamp(0.72rem, 0.58rem + 0.55vw, 1rem);
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  line-height: 1.15;

  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;

  pointer-events: none;

  box-shadow:
    0 3px 10px rgba(0, 0, 0, 0.2),
    0 1px 2px rgba(0, 0, 0, 0.16);
}

/* =========================================================
   FAVORITE
   ========================================================= */

.card__favorite {
  position: absolute;

  top: 0.25rem;
  right: 0.25rem;
  z-index: 4;

  width: var(--touch-target);
  min-width: var(--touch-target);

  height: var(--touch-target);
  min-height: var(--touch-target);

  border: 1px solid var(--ui-border);
  border-radius: 0.5rem;

  background: var(--ui-bg);
}

/* =========================================================
   BODY
   ========================================================= */

.card__body {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;

  padding: var(--card-inset);
}

.card__category {
  display: block;

  min-width: 0;

  overflow: hidden;

  color: var(--ui-text-muted);

  font-size: clamp(0.6875rem, 0.64rem + 0.2vw, 0.75rem);
  line-height: 1.3;

  text-overflow: ellipsis;
  white-space: nowrap;
}

.card__category:hover,
.card__link:hover {
  color: var(--ui-primary);
}

.card__link {
  display: block;
  min-width: 0;
}

.card__title {
  display: -webkit-box;

  min-height: 2.6em;
  margin-top: 0.125rem;

  overflow: hidden;

  font-size: clamp(0.8125rem, 0.72rem + 0.3vw, 0.9375rem);
  font-weight: 600;
  line-height: 1.3;

  overflow-wrap: anywhere;

  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.card__img:focus-visible,
.card__link:focus-visible,
.card__category:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: -2px;
}

/* =========================================================
   PRICE
   ========================================================= */

.card__bottom {
  display: grid;

  grid-template-columns: minmax(0, 1fr);

  min-width: 0;

  gap: 0.25rem;

  margin-top: auto;
  padding-top: 0.25rem;
}

.card__bottom :deep(.price) {
  min-width: 0;

  font-size: clamp(0.8125rem, 0.75rem + 0.25vw, 1rem);
}

.card__bottom :deep(.price__unit) {
  font-size: clamp(0.6875rem, 0.6rem + 0.25vw, 0.8125rem);
}

/* =========================================================
   FULL WIDTH BOTTOM CONTROLS
   ========================================================= */

.card__add,
.card__control {
  width: calc(100% + 2 * var(--card-inset));

  min-width: 0;
  min-height: var(--touch-target);

  margin-inline: calc(-1 * var(--card-inset));
  margin-bottom: calc(-1 * var(--card-inset));

  border-radius: 0;
}

/* =========================================================
   ADD BUTTON
   ========================================================= */

.card__add {
  display: flex;
  max-width: none;

  flex-wrap: nowrap;
  align-items: center;

  gap: 0.25rem;

  padding-inline: 0.5rem;
}

.card__add-label {
  flex: 1;

  min-width: 0;

  overflow: hidden;

  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card__add-icon {
  flex: none;

  width: 1rem;
  height: 1rem;
}

/* =========================================================
   ADDED CONTROL: − TOTAL +
   ========================================================= */

.card__control {
  display: grid;

  grid-template-columns:
    var(--touch-target)
    minmax(0, 1fr)
    var(--touch-target);

  align-items: center;

  border-top: 1px solid
    color-mix(in srgb, var(--ui-primary) 45%, var(--ui-border));

  background: color-mix(in srgb, var(--ui-primary) 18%, var(--ui-bg));

  color: var(--ui-text-highlighted);
}

/* Чуть сильнее подчёркиваем added-state */
.card--added .card__control {
  background: color-mix(in srgb, var(--ui-primary) 22%, var(--ui-bg));
}

.card__portion {
  display: flex;

  width: var(--touch-target);
  min-width: var(--touch-target);

  height: var(--touch-target);
  min-height: var(--touch-target);

  align-items: center;
  justify-content: center;

  padding: 0;
}

/* Общая серверная стоимость позиции */
.card__total {
  min-width: 0;

  padding-inline: 0.125rem;

  overflow: hidden;

  font-size: clamp(0.6875rem, 0.625rem + 0.3vw, 0.8125rem);
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  line-height: 1.2;

  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card__total--stale {
  opacity: 0.68;
}

/* =========================================================
   SMALL MOBILE
   ========================================================= */

@media (width < 23rem) {
  .card {
    --card-inset: 0.3125rem;
  }

  .card__quantity {
    max-width: calc(100% - 0.5rem);

    padding: 0.2rem 0.4rem;

    font-size: 0.7rem;
  }

  .card__favorite {
    top: 0.1875rem;
    right: 0.1875rem;
  }

  .card__title {
    font-size: 0.78rem;
  }

  .card__total {
    font-size: 0.68rem;
  }
}

/* =========================================================
   DESKTOP
   ========================================================= */

@media (min-width: 64rem) {
  .card__quantity {
    font-size: 0.9rem;
  }
}
</style>
