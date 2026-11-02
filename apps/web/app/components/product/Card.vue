<template>
  <article class="card" :style="{ borderColor: product.marketPoint?.cardColor ?? undefined }" :class="{ 'card--added': action.added, 'card--compact': compact, 'card--dense': density > 2, 'card--tiny': density === 4 }">
    <div class="card__media">
      <NuxtLink :to="`/product/${product.slug}`" class="card__img">
        <ProductImage
          :image="product.images[0]"
          :alt="product.images[0]?.alt || product.name"
          :context="compact ? 'compact' : 'card'"
          :identity="product.id"
          :eager-image="eagerImage"
        >
          <span> Фото скоро </span>
        </ProductImage>
      </NuxtLink>

      <span
        v-if="action.added"
        class="card__quantity"
        :title="totalLabel"
        role="status"
        aria-live="polite"
      >
        <span class="sr-only">В корзине: </span>{{ quantityLabel }}
      </span>
      <ProductFavorite class="card__favorite" :product="product" />
      <div v-if="seasonal || product.isHit" class="card__badges">
        <span v-if="product.isHit" class="card__ribbon card__ribbon--hit">ХИТ</span>
        <span v-if="seasonal" class="card__ribbon card__ribbon--season">СЕЗОН</span>
      </div>
    </div>

    <div class="card__body">
      <NuxtLink
        v-if="!compact"
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

      <ProductOrigin :point="product.marketPoint" :price-status="product.priceStatus" />
      <p v-if="saleExplanation(product)" class="card__sale">{{ saleExplanation(product) }}</p>

      <div class="card__bottom">
        <ProductPrice :product="product" />

        <UButton
          v-if="!action.added"
          class="card__add"
          :aria-label="action.ariaLabel"
          :disabled="!cart.restored || cart.serverBusy"
          @click="add"
        >
          <UIcon
            name="i-lucide-plus"
            mode="svg"
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
            :disabled="cart.serverBusy || previousCartQty(cartQty, cartProduct) === null"
            @click="subtract"
          />
          <UButton
            icon="i-lucide-plus"
            variant="ghost"
            color="neutral"
            class="card__portion"
            :aria-label="action.ariaLabel"
            :disabled="cart.serverBusy || nextCartQty(cartQty, cartProduct) === null"
            @click="add"
          />
        </div>
      </div>
    </div>
  </article>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, watch } from 'vue';
import type { ProductListItem } from "~/types/product";
import { useCartStore } from "~/stores/cart";
import { quickAddState } from "~/utils/quick-add";
import { nextCartQty, previousCartQty } from "~/utils/cart";
import { qtyText } from "~/utils/qty";
import { money } from "~/utils/money";
import { saleExplanation, variableWeight } from '~/utils/sale';

const { product, eagerImage = false, density = 2 } = defineProps<{
  product: ProductListItem;
  compact?: boolean;
  density?: 2 | 3 | 4;
  eagerImage?: boolean;
}>();

const cart = useCartStore();
const actions = useCartActions();
const seasonEnded = ref(false);
const seasonal = computed(() => product.isSeasonal && !seasonEnded.value);
let seasonTimer: ReturnType<typeof setTimeout> | undefined;
let mounted = false;
function scheduleSeason() {
  clearTimeout(seasonTimer); seasonEnded.value = false;
  if (!product.isSeasonal || !product.seasonalEndsAt) return;
  const remaining = Date.parse(product.seasonalEndsAt) - Date.now();
  if (remaining <= 0) seasonEnded.value = true;
  else seasonTimer = setTimeout(scheduleSeason, Math.min(remaining, 2_147_483_647));
}
onMounted(() => { mounted = true; scheduleSeason(); });
watch(() => [product.isSeasonal, product.seasonalEndsAt], () => { if (mounted) scheduleSeason(); });
onBeforeUnmount(() => clearTimeout(seasonTimer));
const notice = useHeaderNotice();
const cartQty = computed(() => cart.qty(product.id));
const cartProduct = computed(
  () =>
    cart.items.find((item) => item.product.id === product.id)?.product ??
    product,
);
const quantityLabel = computed(() =>
  qtyText(cartProduct.value.unit, cartQty.value, cartProduct.value),
);
const action = computed(() => quickAddState(cartProduct.value, cartQty.value));
const portion = computed(() =>
  qtyText(cartProduct.value.unit, cartProduct.value.step, cartProduct.value),
);
const lineTotal = computed(() => cart.displayLineTotal(product.id));
const totalLabel = computed(() =>
  lineTotal.value !== null
    ? (cart.quoteReady
        ? "Стоимость позиции: "
        : "Последний расчёт позиции, сумма уточняется: ") +
      money(lineTotal.value)
    : cart.quoteReady
      ? variableWeight(cartProduct.value) ? 'Стоимость после взвешивания' : "Проверьте позицию в корзине"
      : "Стоимость позиции рассчитывается",
);

async function add() {
  const added = await actions.add(cartProduct.value);
  notice.show({
    target: "cart",
    text: added
      ? "Добавлено в корзину"
      : "Проверьте количество и лимит позиций в корзине",
  });
}
async function subtract() {
  const changed = await actions.subtract(cartProduct.value);
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
  --card-price-size: clamp(0.8125rem, 0.75rem + 0.25vw, 1rem);

  display: flex;
  min-width: 0;
  flex-direction: column;
  align-self: stretch;
  container-type: inline-size;
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

  aspect-ratio: 4 / 3;

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

  object-fit: cover;
  object-position: center;

  transition:
    opacity 0.2s ease,
    filter 0.2s ease,
    transform 0.2s ease;
}

/* Единая заливка и плетение покрывают всю область фото, включая поля. */
.card--added .card__media::after {
  content: "";
  position: absolute;
  inset: 0;
  z-index: 1;
  pointer-events: none;

  background-color: rgb(15 23 42 / 10%);
  background-image:
    linear-gradient(
      0deg,
      rgb(120 80 40 / 14%) 0 1px,
      rgb(255 245 222 / 20%) 1px 2px,
      rgb(120 80 40 / 10%) 2px 3px,
      transparent 3px
    ),
    linear-gradient(
      90deg,
      rgb(120 80 40 / 14%) 0 1px,
      rgb(255 245 222 / 20%) 1px 2px,
      rgb(120 80 40 / 10%) 2px 3px,
      transparent 3px
    );
  background-size: 18px 18px;
}

/* =========================================================
   QUANTITY BADGE
   ========================================================= */

.card__quantity {
  position: absolute;

  top: 50%;
  left: 50%;
  z-index: 5;

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

.card__media .card__favorite {
  position: absolute;

  top: 0.25rem;
  right: 0.25rem;
  z-index: 4;

  width: 2.375rem;
  min-width: 2.375rem;

  height: 2.375rem;
  min-height: 2.375rem;
  padding: 0;

  border: 1px solid var(--ui-border);
  border-radius: 0.5rem;

  background: var(--ui-bg);
}

.card__favorite::after {
  content: "";
  position: absolute;
  inset: -0.1875rem;
}

/* =========================================================
   BODY
   ========================================================= */

.card__body {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;

  padding: var(--card-inset) var(--card-inset) 0;
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
  min-height: 1.95em;

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
  grid-template-rows: calc(var(--card-price-size) * 1.2) var(--touch-target);

  min-width: 0;

  gap: 0.25rem;

  margin-top: auto;
  padding-top: 0.25rem;
}

.card__bottom :deep(.price) {
  min-width: 0;

  font-size: min(var(--card-price-size), calc((100cqi - 2 * var(--card-inset)) / (var(--price-characters) * 0.6)));
}

.card__bottom :deep(.price__unit) {
  font-size: 0.82em;
}

/* =========================================================
   FULL WIDTH BOTTOM CONTROLS
   ========================================================= */

.card__add,
.card__control {
  width: calc(100% + 2 * var(--card-inset));

  min-width: 0;
  height: var(--touch-target);
  min-height: 0;

  margin-inline: calc(-1 * var(--card-inset));
  margin-bottom: 0;

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
  justify-content: center;

  gap: 0.25rem;

  padding-inline: 0.5rem;
}

.card__add { cursor: pointer; transition: background-color 160ms ease, box-shadow 160ms ease; }
.card__add:disabled { cursor: not-allowed; }
.card__add-icon {
  flex: none;
  width: 1.625rem;
  height: 1.625rem;
  transition: transform 160ms ease;
}
.card__add-icon :deep(path) { stroke-width: 2.5; stroke-linecap: round; }
.card__add:not(:disabled):active .card__add-icon { transform: scale(0.9); }
@media (hover: hover) and (pointer: fine) {
  .card__add:not(:disabled):hover { box-shadow: inset 0 1px 0 rgb(255 255 255 / 18%); }
  .card__add:not(:disabled):hover .card__add-icon { transform: scale(1.12); }
}
@media (prefers-reduced-motion: reduce) {
  .card__add, .card__add-icon { transition: none; }
  .card__add:not(:disabled):hover .card__add-icon, .card__add:not(:disabled):active .card__add-icon { transform: none; }
}

/* =========================================================
   ADDED CONTROL: − +
   ========================================================= */

.card__control {
  display: grid;

  grid-template-columns: repeat(2, minmax(0, 1fr));

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

  width: 100%;
  min-width: 0;

  height: 100%;
  min-height: 0;

  align-items: center;
  justify-content: center;

  padding: 0;
}

.card__portion + .card__portion { border-left: 1px solid var(--ui-border); border-radius: 0; }

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

  .card__media .card__favorite {
    top: 0.1875rem;
    right: 0.1875rem;
  }

  .card__title {
    font-size: 0.78rem;
  }

}

.card__sale { margin-block: 0.25rem; font-size: 0.75rem; line-height: 1.3; color: var(--ui-text-muted); }

.card__badges { position: absolute; top: var(--card-inset); left: 0; z-index: 4; display: grid; justify-items: start; gap: 0.25rem; pointer-events: none; }
.card__ribbon { padding: 0.25rem 0.625rem 0.25rem 0.5rem; border-radius: 0 0.375rem 0.375rem 0; color: #fff; font-size: clamp(0.625rem, 1.8vw, 0.6875rem); font-weight: 800; line-height: 1.25; letter-spacing: 0.025em; box-shadow: 0 1px 3px rgb(0 0 0 / 15%); }
.card__ribbon--season { background: #15803d; }
.card__ribbon--hit { background: #b45309; }

@media (width < 40rem) {
  .card--compact .card__img { aspect-ratio: 4 / 3; }
  .card--compact .card__title { margin-top: 0; }
  .card--compact .card__bottom { gap: 0.125rem; padding-top: 0.125rem; }
}

/* =========================================================
   DESKTOP
   ========================================================= */

@media (min-width: 64rem) {
  .card__quantity {
    font-size: 0.9rem;
  }
}
@media (width < 40rem) {
  .card--dense { --card-inset: 0.25rem; --card-price-size: 0.75rem; border-radius: 0.5rem; }
  .card--dense .card__category, .card--dense .card__sale,
  .card--dense:not(.card--compact) .card__favorite, .card--dense .card__badges,
  .card--dense :deep(.origin) { display: none; }
  .card--dense .card__title { margin-top: 0; font-size: 0.6875rem; }
  .card--dense .card__bottom { gap: 0.125rem; padding-top: 0.125rem; }
  .card--dense .card__quantity { padding: 0.125rem 0.25rem; font-size: clamp(0.5625rem, 10cqi, 0.75rem); }
  .card--tiny .card__title { font-size: 0.625rem; }
  .card--tiny { --card-price-size: 0.6875rem; }
}
</style>
