<template>
  <UContainer v-if="product" class="product">
    <div class="product__navigation">
      <AppBreadcrumbs :items="breadcrumbs" />
      <AppBackButton class="product__back" :fallback="product.category.slug ? `/catalog/${product.category.slug}` : '/catalog'" />
    </div>
    <ProductGallery :images="product.images" :name="product.name" />

    <section class="product__info">
      <NuxtLink
        :to="`/catalog/${product.category.slug}`"
        class="product__category"
      >
        {{ product.category.name }}
      </NuxtLink>

      <div class="product__head">
        <h1 class="product__title">
          {{ product.name }}
        </h1>

        <ProductFavorite :product="product" />
      </div>

      <ProductPrice :product="product" />
      <p v-if="saleExplanation(product)" class="product__text">{{ saleExplanation(product) }}</p>
      <ProductOrigin :point="product.marketPoint" :price-status="product.priceStatus" class="mt-3" />

      <div class="product__buy">
        <UAlert v-if="cartQty && !cartSelectionValid" color="warning" title="Условия продажи изменились. Обновите количество в кнопке или удалите товар через «−»." />

        <UButton
          v-if="!cartQty"
          size="lg"
          class="product__btn"
          :aria-label="action.ariaLabel"
          :disabled="busy || increased === null"
          @click="add"
        >
          <span class="product__btn-label">
            {{ action.label }}<span v-if="total !== null" class="product__btn-price"> · ≈ {{ money(total) }}</span>
          </span>
        </UButton>
        <div v-else class="product__control" role="group" :aria-label="product.name + ': управление корзиной'" :aria-busy="busy">
          <UButton
            icon="i-lucide-minus"
            variant="ghost"
            color="neutral"
            class="product__portion"
            :aria-label="decreased === 0 ? 'Удалить из корзины: ' + product.name : 'Уменьшить на ' + portion + ': ' + product.name"
            :disabled="busy || decreased === null"
            @click="subtract"
          />
          <div v-if="cartSelectionValid" class="product__summary" role="status" aria-live="polite" aria-atomic="true">
            <span class="sr-only">В корзине: </span>
            <span>{{ qtyText(product.unit, cartQty, product) }}</span>
            <span class="product__total">{{ total !== null ? '≈ ' + money(total) : 'Цена уточняется' }}</span>
          </div>
          <UButton v-else variant="ghost" color="neutral" class="product__summary" :disabled="busy || !validCartQty(qty, product)" @click="add">
            <span>Обновить: {{ qtyText(product.unit, qty, product) }}</span>
            <span v-if="total !== null" class="product__total">≈ {{ money(total) }}</span>
          </UButton>
          <UButton
            icon="i-lucide-plus"
            variant="ghost"
            color="neutral"
            class="product__portion"
            :aria-label="action.ariaLabel"
            :disabled="busy || !cartSelectionValid || increased === null"
            @click="add"
          />
        </div>
      </div>
    </section>
    <section
      v-if="product.description"
      class="product__description"
      aria-labelledby="product-description"
    >
      <h2 id="product-description" class="product__subtitle">Описание</h2>
      <p class="product__text">{{ product.description }}</p>
    </section>
  </UContainer>
</template>

<script setup lang="ts">
import { breadcrumbSchema, productSchema, productSeo } from "~/utils/seo";
import type { Product } from "~/types/product";
import { useCartStore } from "~/stores/cart";
import { money } from "~/utils/money";
import { qtyText } from "~/utils/qty";
import { nextCartQty, previousCartQty, previewTotal, validCartQty } from "~/utils/cart";
import { compatibleQuantityUnit, saleExplanation } from '~/utils/sale';
import { quickAddState } from '~/utils/quick-add';

const route = useRoute();
const slug = String(route.params.slug);

const cart = useCartStore();
const actions = useCartActions();
const notice = useHeaderNotice();
const pending = ref(false);
const busy = computed(() => !cart.restored || cart.serverBusy || pending.value);

const { data: product, error } = await useApi<Product>(`/products/${slug}`);

if (error.value || !product.value) {
  throw createError({
    statusCode: error.value?.statusCode === 404 || !error.value ? 404 : 503,
    statusMessage: error.value && error.value.statusCode !== 404 ? "Каталог временно недоступен" : "Товар не найден",
  });
}

const cartItem = computed(() => cart.items.find(item => item.product.id === product.value!.id));
const cartSelectionValid = computed(() => !cartItem.value || (
  validCartQty(cartItem.value.qty, product.value!) &&
  compatibleQuantityUnit(cartItem.value.quantityUnit ?? cartItem.value.product.unit, product.value!)
));
const cartQty = computed(() =>
  product.value ? cart.qty(product.value.id) : 0,
);
const qty = computed(() => cartQty.value
  ? cartSelectionValid.value ? cartQty.value : product.value!.min
  : product.value!.portionQty);
const increased = computed(() => nextCartQty(cartQty.value || undefined, product.value!));
const decreased = computed(() => cartSelectionValid.value ? previousCartQty(cartQty.value, product.value!) : 0);
const action = computed(() => quickAddState(product.value!, cartQty.value));
const portion = computed(() => qtyText(product.value!.unit, product.value!.step, product.value!));
const total = computed(() =>
  (cartQty.value && cartSelectionValid.value ? cart.quoteLine(product.value!.id)?.lineTotal : null) ?? previewTotal(product.value!, qty.value),
);

async function add() {
  if (busy.value || !product.value) return;
  pending.value = true;
  try {
    const changed = cartSelectionValid.value
      ? await actions.add(product.value)
      : await actions.put(product.value, qty.value);
    notice.show({ target: 'cart', text: changed ? 'Количество в корзине сохранено' : 'Проверьте количество и лимит позиций в корзине' });
  } finally {
    pending.value = false;
  }
}

async function subtract() {
  if (busy.value || !product.value) return;
  pending.value = true;
  try {
    const changed = cartSelectionValid.value
      ? await actions.subtract(product.value)
      : await actions.remove(product.value.id);
    notice.show({ target: 'cart', text: changed ? cartQty.value ? 'Количество уменьшено' : 'Удалено из корзины' : 'Проверьте количество в корзине' });
  } finally {
    pending.value = false;
  }
}

const breadcrumbs = computed(() => [
  { label: "Главная", to: "/" },
  { label: "Каталог", to: "/catalog" },
  { label: product.value!.category.name, to: '/catalog/' + encodeURIComponent(product.value!.category.slug) },
  { label: product.value!.name, to: '/product/' + encodeURIComponent(product.value!.slug) },
]);
usePageSeo(() => ({
  ...productSeo(product.value!),
  image: product.value?.images[0]?.url,
  indexable: product.value?.indexable,
}));
useJsonLd(() => [productSchema(product.value!), breadcrumbSchema(breadcrumbs.value)]);
</script>

<style scoped>
.product {
  display: grid;
  min-width: 0;
  gap: calc(var(--card-padding) / 2) var(--card-padding);
  padding-block: 0 var(--page-end);
}

.product__navigation {
  display: grid;
  min-width: 0;
  grid-column: 1 / -1;
}

.product__navigation :deep(.breadcrumbs) { margin-bottom: 0; }
.product__navigation :deep(.breadcrumbs__list) { flex-wrap: nowrap; }
.product__navigation :deep(.breadcrumbs__item) { flex: none; white-space: nowrap; }
.product__navigation :deep(.breadcrumbs__item:nth-last-child(-n + 2)) { flex: 0 1 auto; overflow: hidden; }
.product__navigation :deep(.breadcrumbs__item:nth-last-child(2)) { min-width: calc(var(--touch-target) + 1rem); }
.product__navigation :deep(.breadcrumbs__item:nth-last-child(2) a) { display: block; min-width: 0; overflow: hidden; line-height: var(--touch-target); text-overflow: ellipsis; }
.product__navigation :deep(.breadcrumbs__item:nth-last-child(2) a:focus-visible) { outline-offset: -2px; }
.product__navigation :deep([aria-current="page"]) { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.product__navigation :deep([aria-hidden="true"]) { flex: none; }

.product__info {
  min-width: 0;
  align-self: start;
}

.product__back {
  grid-column: 1 / -1;
}

.product__category {
  display: inline-flex;
  align-items: center;
  min-height: var(--touch-target);
  color: var(--ui-primary);
}

.product__title {
  min-width: 0;
  font-size: var(--page-title);
  font-weight: 700;
  line-height: 1.15;
  overflow-wrap: anywhere;
}

.product__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  margin-block: 0.75rem 1rem;
}

.product__text {
  margin-top: 1rem;
  color: var(--ui-text-muted);
  line-height: 1.65;
  overflow-wrap: anywhere;
  white-space: pre-line;
}
.product__description {
  min-width: 0;
  max-width: 65ch;
}
.product__subtitle {
  font-size: var(--section-title);
  font-weight: 600;
}

.product__buy {
  display: grid;
  gap: 1rem;
  margin-top: var(--card-padding);
}

.product__btn {
  width: 100%;
  min-width: 0;
  min-height: 3.25rem;
  justify-content: center;
  text-align: center;
  white-space: normal;
}

.product__btn-label {
  min-width: 0;
}

.product__btn-price {
  white-space: nowrap;
}

.product__control {
  display: grid;
  min-width: 0;
  min-height: 3.25rem;
  grid-template-columns: 3.25rem minmax(0, 1fr) 3.25rem;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--ui-primary) 45%, var(--ui-border));
  border-radius: 0.5rem;
  background: color-mix(in srgb, var(--ui-primary) 22%, var(--ui-bg));
  color: var(--ui-text-highlighted);
}

.product__portion {
  width: 100%;
  height: 100%;
  padding: 0;
  border-radius: 0;
  color: inherit;
}

.product__portion:first-child { border-right: 1px solid var(--ui-border); }
.product__portion:last-child { border-left: 1px solid var(--ui-border); }

.product__summary {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 0.125rem 0.75rem;
  padding: 0.5rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  text-align: center;
  overflow-wrap: anywhere;
}

.product__total { white-space: nowrap; }

@media (min-width: 48rem) {
  .product {
    grid-template-columns: minmax(0, 1.1fr) minmax(18rem, 0.9fr);
    column-gap: clamp(2rem, 5vw, 4rem);
  }

  .product__description {
    grid-column: 1 / -1;
  }
}
@media (min-width: 80rem) {
  .product:has(.product__description) {
    grid-template-columns: minmax(0, 1.4fr) minmax(16rem, 0.85fr) minmax(
        0,
        0.9fr
      );
    column-gap: 2rem;
  }
  .product__description {
    grid-column: auto;
    padding-left: 1.5rem;
    border-left: 1px solid var(--ui-border);
  }
}
</style>
