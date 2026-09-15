<template>
  <article class="card">
    <div class="card__media">
      <NuxtLink :to="`/product/${product.slug}`" class="card__img">
        <img
          v-if="product.images[0]"
          :src="asset(product.images[0].url)"
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

        <UButton
          class="card__add"
          :aria-label="action.ariaLabel"
          @click="add"
        >
          <UIcon
            v-if="action.added"
            name="i-lucide-check"
            class="card__add-icon"
            aria-hidden="true"
          />
          <span class="card__add-label">{{ action.label }}</span>
          <UIcon name="i-lucide-plus" class="card__add-icon" aria-hidden="true" />
        </UButton>
      </div>
    </div>
  </article>
</template>

<script setup lang="ts">
import type { ProductListItem } from "~/types/product";
import { useCartStore } from "~/stores/cart";
import { quickAddState } from "~/utils/quick-add";

const { product } = defineProps<{
  product: ProductListItem;
}>();

const cart = useCartStore();
const asset = useAsset();
const notice = useHeaderNotice();
const cartQty = computed(() => cart.qty(product.id));
const action = computed(() => quickAddState(product, cartQty.value));

function add() {
  const added = cart.add(product);
  notice.show({ target: 'cart', text: added ? 'Добавлено в корзину' : 'Проверьте количество и лимит позиций в корзине' });
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
