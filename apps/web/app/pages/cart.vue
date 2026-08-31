<template>
  <UContainer class="cart">
    <div class="cart__head">
      <h1 class="cart__title">Корзина</h1>

      <UButton
        v-if="cart.items.length"
        variant="ghost"
        color="neutral"
        @click="cart.clear"
      >
        Очистить
      </UButton>
    </div>

    <div v-if="cart.items.length" class="cart__layout">
      <div class="cart__items">
        <article v-for="item in cart.items" :key="item.product.id" class="item">
          <NuxtLink :to="`/product/${item.product.slug}`" class="item__img">
            <img
              v-if="item.product.images[0]"
              :src="item.product.images[0].url"
              :alt="item.product.images[0].alt || item.product.name"
            />

            <span v-else> Фото </span>
          </NuxtLink>

          <div class="item__body">
            <NuxtLink :to="`/product/${item.product.slug}`" class="item__title">
              {{ item.product.name }}
            </NuxtLink>

            <ProductPrice :product="item.product" />

            <ProductQty
              :model-value="item.qty"
              :product="item.product"
              @update:model-value="cart.setQty(item.product.id, $event)"
            />
          </div>

          <div class="item__side">
            <strong class="item__total">
              {{ money(cart.lineTotal(item)) }}
            </strong>

            <UButton
              icon="i-lucide-trash-2"
              variant="ghost"
              color="neutral"
              aria-label="Удалить"
              @click="cart.remove(item.product.id)"
            />
          </div>
        </article>
      </div>

      <aside class="summary">
        <h2 class="summary__title">Ваш заказ</h2>

        <div class="summary__row">
          <span>Товаров</span>
          <span>{{ cart.count }}</span>
        </div>

        <div class="summary__total">
          <span>Итого</span>
          <strong>{{ money(cart.total) }}</strong>
        </div>

        <UButton to="/checkout" block size="lg"> Оформить заказ </UButton>
      </aside>
    </div>

    <div v-else class="cart__empty">
      <UIcon name="i-lucide-shopping-bag" class="cart__empty-icon" />

      <h2>Корзина пустая</h2>

      <p>Добавьте свежие продукты из каталога.</p>

      <UButton to="/catalog"> Перейти в каталог </UButton>
    </div>
  </UContainer>
</template>

<script setup lang="ts">
import { useCartStore } from "~/stores/cart";
import { money } from "~/utils/money";

const cart = useCartStore();

useSeoMeta({
  title: "Корзина",
});
</script>

<style scoped>
.cart {
  padding-block: 3rem 5rem;
}

.cart__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 2rem;
}

.cart__title {
  font-size: 2.5rem;
  font-weight: 700;
}

.cart__layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 360px;
  gap: 2rem;
}

.cart__items {
  display: grid;
  gap: 1rem;
}

.item {
  display: grid;
  grid-template-columns: 120px minmax(0, 1fr) auto;
  gap: 1.5rem;
  padding: 1rem;
  border: 1px solid var(--ui-border);
  border-radius: 1rem;
}

.item__img {
  display: grid;
  height: 120px;
  place-items: center;
  overflow: hidden;
  border-radius: 0.75rem;
  background: var(--ui-bg-muted);
  color: var(--ui-text-muted);
}

.item__img img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.item__body {
  display: grid;
  align-content: center;
  justify-items: start;
  gap: 0.75rem;
}

.item__title {
  font-size: 1.125rem;
  font-weight: 600;
}

.item__title:hover {
  color: var(--ui-primary);
}

.item__side {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  justify-content: space-between;
}

.item__total {
  font-size: 1.125rem;
}

.summary {
  align-self: start;
  padding: 1.5rem;
  border: 1px solid var(--ui-border);
  border-radius: 1rem;
}

.summary__title {
  margin-bottom: 1.5rem;
  font-size: 1.25rem;
  font-weight: 600;
}

.summary__row,
.summary__total {
  display: flex;
  justify-content: space-between;
}

.summary__row {
  color: var(--ui-text-muted);
}

.summary__total {
  margin-block: 1rem 1.5rem;
  padding-top: 1rem;
  border-top: 1px solid var(--ui-border);
  font-size: 1.25rem;
}

.cart__empty {
  display: grid;
  max-width: 420px;
  margin: 7rem auto;
  justify-items: center;
  gap: 1rem;
  text-align: center;
}

.cart__empty-icon {
  width: 3rem;
  height: 3rem;
  color: var(--ui-text-muted);
}

.cart__empty p {
  color: var(--ui-text-muted);
}

@media (max-width: 900px) {
  .cart__layout {
    grid-template-columns: 1fr;
  }

  .summary {
    width: 100%;
  }
}

@media (max-width: 600px) {
  .item {
    grid-template-columns: 80px 1fr;
  }

  .item__img {
    height: 80px;
  }

  .item__side {
    grid-column: 1 / -1;
    flex-direction: row;
    align-items: center;
  }
}
</style>
