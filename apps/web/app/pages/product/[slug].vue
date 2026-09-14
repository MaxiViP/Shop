<template>
  <UContainer v-if="product" class="product">
    <AppBackButton class="product__back" :fallback="product.category.slug ? `/catalog/${product.category.slug}` : '/catalog'" />
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

      <div class="product__buy">
        <UAlert v-if="cartQty && !validCartQty(cartQty, product)" color="warning" title="Сохранённое количество не соответствует текущему шагу. Выберите новое и нажмите «Обновить количество»." />
        <ProductQty v-model="qty" :product="product" />

        <div class="product__purchase">
          <span v-if="cartQty" class="product__cart-qty">
            В корзине: {{ qtyText(product.unit, cartQty) }}
          </span>

          <UButton size="lg" class="product__btn" @click="add">
            {{ cartQty ? 'Обновить количество' : 'В корзину' }} · {{ money(total) }}
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
import type { Product } from "~/types/product";
import { useCartStore } from "~/stores/cart";
import { money } from "~/utils/money";
import { qtyText } from "~/utils/qty";
import { validCartQty } from "~/utils/cart";

const route = useRoute();
const slug = String(route.params.slug);

const cart = useCartStore();
const notice = useHeaderNotice();

function add() {
  if (!product.value) return;

  const updated = cart.put(product.value, qty.value);
  notice.show({ target: 'cart', text: updated ? 'Количество в корзине сохранено' : 'Проверьте количество и лимит позиций в корзине' });
}

const { data: product, error } = await useApi<Product>(`/products/${slug}`);

if (error.value || !product.value) {
  throw createError({
    status: 404,
    statusText: "Товар не найден",
  });
}

const qty = ref(product.value.min);
watch(() => [cart.restored, cart.qty(product.value!.id)], () => {
  const current = cart.qty(product.value!.id);
  if (current) qty.value = validCartQty(current, product.value!) ? current : product.value!.min;
}, { immediate: true });

const total = computed(() => {
  if (!product.value) return 0;

  return Math.round((product.value.price * qty.value) / product.value.priceQty);
});

const cartQty = computed(() =>
  product.value ? cart.qty(product.value.id) : 0,
);

useSeoMeta({
  title: () => product.value?.name ?? "Товар",
  description: () =>
    product.value?.description ??
    `${product.value?.name ?? "Продукт"} с доставкой по Москве.`,
});
</script>

<style scoped>
.product {
  display: grid;
  min-width: 0;
  gap: var(--card-padding);
  padding-block: var(--page-start) var(--page-end);
}

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
  min-height: var(--touch-target);
  justify-content: center;
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
    gap: clamp(2rem, 5vw, 4rem);
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
    gap: 2rem;
  }
  .product__description {
    grid-column: auto;
    padding-left: 1.5rem;
    border-left: 1px solid var(--ui-border);
  }
}
</style>
