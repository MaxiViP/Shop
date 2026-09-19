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

      <span v-if="action.added" class="card__quantity" role="status" aria-live="polite">
        <span class="sr-only">В корзине: </span>{{ action.label }}
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
          <UIcon name="i-lucide-plus" class="card__add-icon" aria-hidden="true" />
        </UButton>
        <div v-else class="card__control" role="group" :aria-label="product.name + ': в корзине ' + action.label">
          <UButton
            icon="i-lucide-minus"
            variant="ghost"
            color="neutral"
            class="card__portion"
            :aria-label="'Уменьшить на ' + portion + ': ' + product.name"
            :disabled="previousCartQty(cartQty, cartProduct) === null"
            @click="subtract"
          />
          <span class="card__total" :class="{ 'card__total--stale': !cart.quoteReady }" :title="totalLabel" :aria-label="totalLabel">
            {{ lineTotal !== null ? money(lineTotal) : '…' }}
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
const cartProduct = computed(() => cart.items.find(item => item.product.id === product.id)?.product ?? product);
const action = computed(() => quickAddState(cartProduct.value, cartQty.value));
const portion = computed(() => qtyText(cartProduct.value.unit, cartProduct.value.portionQty));
const lineTotal = computed(() => cart.displayLineTotal(product.id));
const totalLabel = computed(() => lineTotal.value !== null
  ? (cart.quoteReady ? 'Стоимость позиции: ' : 'Последний расчёт позиции, сумма уточняется: ') + money(lineTotal.value)
  : cart.quoteReady ? 'Проверьте позицию в корзине' : 'Стоимость позиции рассчитывается');

function add() {
  const added = cart.add(cartProduct.value);
  notice.show({ target: 'cart', text: added ? 'Добавлено в корзину' : 'Проверьте количество и лимит позиций в корзине' });
}
function subtract() {
  const changed = cart.subtract(cartProduct.value);
  notice.show({ target: 'cart', text: changed
    ? cart.qty(product.id) ? 'Количество уменьшено' : 'Удалено из корзины'
    : 'Проверьте количество в корзине' });
}
</script>

<style scoped>
.card {
  --card-inset: clamp(0.625rem, 0.5rem + 0.5vw, 1rem);
  display: flex;
  min-width: 0;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--ui-border);
  border-radius: 1rem;
}

.card--added {
  border-color: var(--ui-primary);
}

.card--added .card__img > * {
  opacity: 0.45;
  filter: grayscale(0.25);
}

.card__quantity {
  position: absolute;
  inset-inline: 0.5rem;
  bottom: 0.5rem;
  width: fit-content;
  max-width: calc(100% - 1rem);
  margin-inline: auto;
  padding: 0.25rem 0.625rem;
  border-radius: 0.75rem;
  background: var(--ui-bg);
  color: var(--ui-text-highlighted);
  font-size: clamp(1.125rem, 3.5vw, 1.5rem);
  font-weight: 700;
  line-height: 1.25;
  text-align: center;
  overflow-wrap: anywhere;
  pointer-events: none;
}

.card__control {
  display: grid;
  grid-template-columns: var(--touch-target) minmax(0, 1fr) var(--touch-target);
  align-items: center;
  min-width: 0;
  min-height: var(--touch-target);
  margin-inline: calc(-1 * var(--card-inset));
  margin-bottom: calc(-1 * var(--card-inset));
  background: var(--ui-bg-elevated);
  border-top: 1px solid var(--ui-border);
}

.card__portion {
  width: var(--touch-target);
  min-height: var(--touch-target);
  padding: 0;
  justify-content: center;
}

.card__total {
  min-width: 0;
  padding: 0.125rem;
  font-size: 0.8125rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 1.25;
  text-align: center;
  overflow-wrap: anywhere;
}

.card__total--stale {
  color: var(--ui-text-muted);
}

.card__img:focus-visible,
.card__link:focus-visible,
.card__category:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: -2px;
}

.card__media {
  position: relative;
}

.card__favorite {
  position: absolute;
  top: 0.75rem;
  right: 0.75rem;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg);
}

.card__img {
  display: grid;
  aspect-ratio: 4 / 3;
  place-items: center;
  background: var(--ui-bg-muted);
  color: var(--ui-text-muted);
}

.card__img img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

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
  min-height: var(--touch-target);
  align-content: center;
  color: var(--ui-text-muted);
  overflow: hidden;
  font-size: 0.8125rem;
  line-height: 1.4;
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
  min-height: var(--touch-target);
}

.card__title {
  margin-top: 0.25rem;
  min-height: 2.8em;
  overflow-wrap: anywhere;
  overflow: hidden;
  font-size: 0.9375rem;
  font-weight: 600;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.card__bottom {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  min-width: 0;
  gap: 0.5rem;
  margin-top: auto;
  padding-top: 0.75rem;
}

.card__bottom :deep(.price) {
  min-width: 0;
}

.card__add {
  display: flex;
  flex-wrap: nowrap;
  width: 100%;
  min-width: 0;
  min-height: var(--touch-target);
  align-items: center;
  gap: 0.25rem;
}

.card__add-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}

.card__add-icon {
  flex: none;
  width: 1rem;
  height: 1rem;
}

.card__favorite {
  min-width: var(--touch-target);
  min-height: var(--touch-target);
  flex: 0 0 auto;
}

@media (min-width: 40rem) {
  .card__category {
    font-size: 0.8125rem;
  }

  .card__title {
    font-size: 1rem;
  }

  .card__bottom {
    gap: 0.65rem;
  }
}
</style>
