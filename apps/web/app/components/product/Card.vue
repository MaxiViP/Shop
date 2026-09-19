<template>
  <article class="card" :class="{ 'card--added': action.added }">
    <div class="card__media">
      <NuxtLink :to="`/product/${product.slug}`" class="card__img">
        <img
          v-if="product.images[0]"
          :src="asset(product.images[0].url)"
          :alt="product.images[0].alt || product.name"
        >
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
  --card-inset: 0.625rem;

  display: flex;
  min-width: 0;
  flex-direction: column;
  overflow: hidden;

  border: 1px solid var(--ui-border);
  border-radius: 1rem;

  background: var(--ui-bg);
}

/* Добавленный товар не меняет форму карточки */
.card--added {
  border-color: var(--ui-border);
}

/* Затемняем ТОЛЬКО фотографию */
.card--added .card__img img {
  opacity: 0.58;
  filter: brightness(0.9);
}

/* =========================================================
   MEDIA
   ========================================================= */

.card__media {
  position: relative;
  background: #fff;
}

.card__img {
  display: grid;
  width: 100%;
  aspect-ratio: 4 / 3;

  place-items: center;
  overflow: hidden;

  background: #fff;
  color: var(--ui-text-muted);
}

.card__img img {
  width: 100%;
  height: 100%;

  object-fit: contain;

  transition:
    opacity 0.2s ease,
    filter 0.2s ease;
}

/* Количество — по центру НИЖНЕГО края картинки */
.card__quantity {
  position: absolute;
  top: 50%;
  left: 50%;
  z-index: 3;
  transform: translate(-50%, -50%);
  width: max-content;
  max-width: calc(100% - 1rem);
  padding: 0.3rem 0.65rem;
  border-radius: 0.7rem;
  background: #101b31;
  color: #fff;
  font-size: 0.95rem;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  line-height: 1.15;
  text-align: center;
  white-space: nowrap;
  pointer-events: none;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.28);
}
/* =========================================================
   FAVORITE
   ========================================================= */

.card__favorite {
  position: absolute;
  top: 0.625rem;
  right: 0.625rem;
  z-index: 4;

  width: var(--touch-target);
  min-width: var(--touch-target);
  height: var(--touch-target);
  min-height: var(--touch-target);

  border: 0;
  border-radius: 0.4rem;

  background: #101b31;

  flex: 0 0 auto;
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
  min-height: 1.5rem;

  color: var(--ui-text-muted);

  overflow: hidden;
  font-size: 0.75rem;
  line-height: 1.25;

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

  min-height: 2.5rem;
  margin-top: 0.35rem;

  overflow: hidden;

  font-size: 0.875rem;
  font-weight: 700;
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
   PRICE + CONTROL
   ========================================================= */

.card__bottom {
  display: grid;

  grid-template-columns: minmax(0, 1fr);

  min-width: 0;

  gap: 0.45rem;
  margin-top: auto;
  padding-top: 0.5rem;
}

.card__bottom :deep(.price) {
  min-width: 0;

  font-size: 0.95rem;
  font-weight: 700;
}

/* =========================================================
   BUTTON "В КОРЗИНУ"
   ========================================================= */

.card__add {
  display: flex;

  width: 100%;
  min-width: 0;
  min-height: var(--touch-target);

  align-items: center;

  gap: 0.25rem;

  border-radius: 0.5rem;
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
   ДОБАВЛЕННЫЙ ТОВАР: − СУММА +
   ========================================================= */

.card__control {
  display: grid;

  grid-template-columns:
    var(--touch-target)
    minmax(0, 1fr)
    var(--touch-target);

  align-items: center;

  min-width: 0;
  min-height: var(--touch-target);

  margin-inline: calc(-1 * var(--card-inset));
  margin-bottom: calc(-1 * var(--card-inset));

  overflow: hidden;

  border-top: 1px solid var(--ui-border);
  border-radius: 0 0 0.875rem 0.875rem;

  background: var(--ui-bg-elevated);
}

.card__portion {
  width: var(--touch-target);
  min-width: var(--touch-target);
  height: var(--touch-target);
  min-height: var(--touch-target);

  padding: 0;

  justify-content: center;
}

.card__total {
  min-width: 0;

  padding-inline: 0.25rem;

  overflow: hidden;

  font-size: 0.75rem;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  line-height: 1.2;

  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card__total--stale {
  opacity: 0.65;
}

/* =========================================================
   TABLET+
   ========================================================= */

@media (min-width: 40rem) {
  .card {
    --card-inset: 0.75rem;
  }

  .card__category {
    font-size: 0.75rem;
  }

  .card__title {
    font-size: 0.9375rem;
  }

  .card__quantity {
    bottom: 0.625rem;

    padding: 0.3rem 0.65rem;

    font-size: 1rem;
  }

  .card__bottom {
    gap: 0.55rem;
  }
}
</style>
