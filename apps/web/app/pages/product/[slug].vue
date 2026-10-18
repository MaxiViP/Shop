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
        <UAlert v-if="cartQty && !cartSelectionValid" color="warning" title="Условия продажи изменились. Выберите количество заново и нажмите «Обновить количество в корзине»." />
        <ProductQty v-model="qty" :product="product" />

        <div class="product__purchase">
          <span v-if="cartQty" class="product__cart-qty">
            В корзине: {{ qtyText(cartItem?.quantityUnit ?? cartItem?.product.unit ?? product.unit, cartQty) }}
          </span>

          <UButton size="lg" class="product__btn" :disabled="!cart.restored || cart.serverBusy || !validCartQty(qty, product)" @click="add">
            <span class="product__btn-label">
              {{ cartQty ? 'Обновить количество в корзине' : quickAddState({ ...product, portionQty: qty }, 0).label }}<span v-if="total !== null" class="product__btn-price"> · ≈ {{ money(total) }}</span>
            </span>
          </UButton>
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
import { previewTotal, validCartQty } from "~/utils/cart";
import { compatibleQuantityUnit, saleExplanation } from '~/utils/sale';
import { quickAddState } from '~/utils/quick-add';

const route = useRoute();
const slug = String(route.params.slug);

const cart = useCartStore();
const actions = useCartActions();
const notice = useHeaderNotice();

async function add() {
  if (!cart.restored || !product.value || !validCartQty(qty.value, product.value)) return;

  const updated = await actions.put(product.value, qty.value);
  notice.show({ target: 'cart', text: updated ? 'Количество в корзине сохранено' : 'Проверьте количество и лимит позиций в корзине' });
}

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
const qty = ref(product.value.portionQty);
watch(() => [cart.restored, cartItem.value?.qty, cartItem.value?.quantityUnit, cartItem.value?.product.unit], () => {
  const current = cartItem.value?.qty;
  if (current) qty.value = cartSelectionValid.value ? current : product.value!.min;
}, { immediate: true });

const total = computed(() => {
  if (!product.value) return 0;

  return previewTotal(product.value, qty.value);
});

const cartQty = computed(() =>
  product.value ? cart.qty(product.value.id) : 0,
);

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
  min-height: var(--touch-target);
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

.product__purchase {
  display: grid;
  min-width: 0;
  gap: 0.5rem;
}

.product__cart-qty {
  color: var(--ui-text-muted);
  font-weight: 600;
  overflow-wrap: anywhere;
}

@media (min-width: 48rem) {
  .product {
    grid-template-columns: minmax(0, 1.1fr) minmax(18rem, 0.9fr);
    column-gap: clamp(2rem, 5vw, 4rem);
  }

  .product__description {
    grid-column: 1 / -1;
  }

  .product__btn {
    width: auto;
    justify-self: start;
  }

  .product__purchase {
    gap: 0.75rem;
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
