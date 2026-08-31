<template>
  <UContainer v-if="product" class="product">
    <div class="product__media">
      <img
        v-if="product.images[0]"
        :src="product.images[0].url"
        :alt="product.images[0].alt || product.name"
      />

      <span v-else> Фото скоро </span>
    </div>

    <section class="product__info">
      <NuxtLink
        :to="`/catalog/${product.category.slug}`"
        class="product__category"
      >
        {{ product.category.name }}
      </NuxtLink>

      <h1 class="product__title">
        {{ product.name }}
      </h1>

      <ProductPrice :product="product" />

      <p v-if="product.description" class="product__text">
        {{ product.description }}
      </p>

      <div class="product__buy">
        <ProductQty v-model="qty" :product="product" />

        <UButton size="lg" class="product__btn" @click="add">
          В корзину · {{ money(total) }}
        </UButton>
      </div>
    </section>
  </UContainer>
</template>

<script setup lang="ts">
import type { Product } from "~/types/product";
import { useCartStore } from '~/stores/cart'
import { money } from '~/utils/money'

const route = useRoute();
const slug = String(route.params.slug);

const cart = useCartStore()
const toast = useToast()

function add() {
  if (!product.value) return

  cart.add(product.value, qty.value)

  toast.add({
    title: `${product.value.name} добавлен`,
  })
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
  grid-template-columns: minmax(0, 1fr) minmax(320px, 0.8fr);
  gap: 4rem;
  padding-block: 4rem;
}

.product__media {
  display: grid;
  min-height: 520px;
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
  align-self: center;
}

.product__category {
  color: var(--ui-primary);
}

.product__title {
  margin-block: 0.75rem 1rem;
  font-size: clamp(2rem, 5vw, 3.5rem);
  font-weight: 700;
  line-height: 1.05;
}

.product__text {
  margin-top: 1.5rem;
  color: var(--ui-text-muted);
}

.product__buy {
  display: grid;
  gap: 1rem;
  margin-top: 2rem;
}

.product__btn {
  justify-content: center;
}

@media (max-width: 768px) {
  .product {
    grid-template-columns: 1fr;
    gap: 2rem;
    padding-block: 2rem;
  }

  .product__media {
    min-height: 360px;
  }
}
</style>
