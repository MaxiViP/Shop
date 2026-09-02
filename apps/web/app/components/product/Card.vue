<template>
  <article class="card">
    <div class="card__media">
      <NuxtLink :to="`/product/${product.slug}`" class="card__img">
        <img
          v-if="product.images[0]"
          :src="product.images[0].url"
          :alt="product.images[0].alt || product.name"
        >

        <span v-else> Фото скоро </span>
      </NuxtLink>

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

        <div class="card__cart">
          <span v-if="cartQty" class="card__qty">
            {{ qtyText(product.unit, cartQty) }}
          </span>

          <UButton
            icon="i-lucide-plus"
            :aria-label="`Добавить ${product.name} в корзину`"
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
import { qtyText } from "~/utils/qty";

const { product } = defineProps<{
  product: ProductListItem;
}>();

const cart = useCartStore();
const toast = useToast();
const cartQty = computed(() => cart.qty(product.id));

function add() {
  cart.add(product);

  toast.add({
    title: `${product.name} добавлен`,
  });
}
</script>

<style scoped>
.card {
  display: flex;
  min-width: 0;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--ui-border);
  border-radius: 1rem;
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
  padding: clamp(0.625rem, 0.5rem + 0.5vw, 1rem);
}

.card__category {
  display: block;
  min-width: 0;
  min-height: 1.2em;
  color: var(--ui-text-muted);
  overflow: hidden;
  font-size: 0.75rem;
  line-height: 1.2;
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
  margin-top: 0.25rem;
  min-height: 2.5em;
  overflow: hidden;
  font-size: 0.9375rem;
  font-weight: 600;
  line-height: 1.25;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.card__bottom {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  min-width: 0;
  gap: 0.5rem;
  margin-top: auto;
  padding-top: 0.75rem;
}

.card__bottom :deep(.price) {
  min-width: 0;
  flex: 1 1 auto;
}

.card__cart {
  display: grid;
  min-width: 0;
  max-width: 100%;
  justify-items: center;
  gap: 0.125rem;
}

.card__qty {
  min-width: 0;
  max-width: 100%;
  color: var(--ui-text);
  font-size: 0.75rem;
  font-weight: 600;
  line-height: 1.2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card__favorite,
.card__cart :deep(button) {
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
    gap: 0.75rem;
  }

  .card__qty {
    font-size: 0.8125rem;
  }
}
</style>
