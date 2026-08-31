<template>
  <article class="card">
    <NuxtLink
      :to="`/product/${product.slug}`"
      class="card__img"
    >
      <img
        v-if="product.images[0]"
        :src="product.images[0].url"
        :alt="product.images[0].alt || product.name"
      >

      <span v-else>
        Фото скоро
      </span>
    </NuxtLink>

    <div class="card__body">
      <NuxtLink
        :to="`/catalog/${product.category.slug}`"
        class="card__category"
      >
        {{ product.category.name }}
      </NuxtLink>

      <NuxtLink
        :to="`/product/${product.slug}`"
        class="card__link"
      >
        <h3 class="card__title">
          {{ product.name }}
        </h3>
      </NuxtLink>

      <div class="card__bottom">
        <ProductPrice :product="product" />

        <UButton
          icon="i-lucide-plus"
          aria-label="Добавить в корзину"
          @click="add"
        />
      </div>
    </div>
  </article>
</template>

<script setup lang="ts">
import type { Product } from '~/types/product'
import { useCartStore } from '~/stores/cart'

const { product } = defineProps<{
  product: Product
}>()

const cart = useCartStore()
const toast = useToast()

function add() {
  cart.add(product)

  toast.add({
    title: `${product.name} добавлен`,
  })
}
</script>

<style scoped>
.card {
  overflow: hidden;
  border: 1px solid var(--ui-border);
  border-radius: 1rem;
}

.card__img {
  display: grid;
  height: 220px;
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
  padding: 1rem;
}

.card__category {
  color: var(--ui-text-muted);
  font-size: 0.875rem;
}

.card__category:hover,
.card__link:hover {
  color: var(--ui-primary);
}

.card__title {
  margin-top: 0.25rem;
  font-size: 1.125rem;
  font-weight: 600;
}

.card__bottom {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  margin-top: 1rem;
}
</style>
