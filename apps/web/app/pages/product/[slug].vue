<template>
  <UContainer v-if="product" class="product">
    <div class="product__media">
      <img
        v-if="product.images[0]"
        :src="product.images[0].url"
        :alt="product.images[0].alt || product.name"
      >

      <span v-else> Фото скоро </span>
    </div>

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

      <p v-if="product.description" class="product__text">
        {{ product.description }}
      </p>

      <div class="product__buy">
        <ProductQty v-model="qty" :product="product" />

        <div class="product__purchase">
          <span v-if="cartQty" class="product__cart-qty">
            В корзине: {{ qtyText(product.unit, cartQty) }}
          </span>

          <UButton size="lg" class="product__btn" @click="add">
            В корзину · {{ money(total) }}
          </UButton>
        </div>
      </div>
    </section>
  </UContainer>
</template>

<script setup lang="ts">
import type { Product } from "~/types/product";
import { useCartStore } from "~/stores/cart";
import { money } from "~/utils/money";
import { qtyText } from "~/utils/qty";

const route = useRoute();
const slug = String(route.params.slug);

const cart = useCartStore();
const toast = useToast();

function add() {
  if (!product.value) return;

  cart.add(product.value, qty.value);

  toast.add({
    title: `${product.value.name} добавлен`,
  });
}

const { data: product, error } = await useApi<Product>(`/products/${slug}`);

if (error.value || !product.value) {
  throw createError({
    status: 404,
    statusText: "Товар не найден",
  });
}

const qty = ref(product.value.min);

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
  gap: 2rem;
  padding-block: var(--page-start) var(--page-end);
}

.product__media {
  display: grid;
  width: 100%;
  aspect-ratio: 4 / 3;
  place-items: center;
  overflow: hidden;
  border-radius: 1.5rem;
  background: var(--ui-bg-muted);
  color: var(--ui-text-muted);
}

.product__media img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.product__info {
  min-width: 0;
  align-self: center;
}

.product__category {
  color: var(--ui-primary);
}

.product__title {
  min-width: 0;
  font-size: var(--page-title);
  font-weight: 700;
  line-height: 1.05;
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
  margin-top: 1.5rem;
  color: var(--ui-text-muted);
  line-height: 1.65;
  overflow-wrap: anywhere;
}

.product__buy {
  display: grid;
  gap: 1rem;
  margin-top: 2rem;
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

  .product__media {
    aspect-ratio: 1 / 1;
  }

  .product__btn {
    width: auto;
    justify-self: start;
  }

  .product__purchase {
    gap: 0.75rem;
  }
}
</style>
