<template>
  <div class="cart-items">
    <article v-for="item in cart.items" :key="item.product.id" class="item">
      <NuxtLink :to="`/product/${item.product.slug}`" class="item__img">
        <img
          v-if="item.product.images[0]"
          :src="asset(item.product.images[0].url)"
          :alt="item.product.images[0].alt || item.product.name"
        >

        <span v-else> Фото </span>
      </NuxtLink>

      <div class="item__body">
        <NuxtLink :to="`/product/${item.product.slug}`" class="item__title">
          {{ item.product.name }}
        </NuxtLink>

        <ProductPrice v-if="ready && cart.quoteLine(item.product.id)?.product" :product="item.product" />
        <span v-else-if="!ready" class="text-muted" role="status">Проверяем цену…</span>
        <p v-if="ready && cartLineMessage(cart.quoteLine(item.product.id))" class="text-error" role="alert">{{ cartLineMessage(cart.quoteLine(item.product.id)) }}</p>
        <template v-if="ready && cart.quoteLine(item.product.id)?.status === 'INVALID_QUANTITY'">
          <p class="text-muted">Выбрано: {{ qtyText(item.product.unit, item.qty) }}. Минимум: {{ qtyText(item.product.unit, item.product.min) }}, шаг: {{ qtyText(item.product.unit, item.product.step) }}.</p>
          <UButton color="neutral" variant="soft" @click="setQty(item.product.id, item.product.min)">Установить {{ qtyText(item.product.unit, item.product.min) }}</UButton>
        </template>

        <ProductQty
          v-else-if="!ready || cart.quoteLine(item.product.id)?.product"
          :model-value="item.qty"
          :product="item.product"
          @update:model-value="setQty(item.product.id, $event)"
        />
      </div>

      <div class="item__side">
        <strong v-if="ready && cart.lineTotal(item) !== null" class="item__total">
          {{ money(cart.lineTotal(item) ?? 0) }}
        </strong>

        <UButton
          class="item__remove"
          icon="i-lucide-trash-2"
          variant="ghost"
          color="neutral"
          :aria-label="'Удалить из корзины: ' + item.product.name"
          @click="remove(item.product.id)"
        />
      </div>
    </article>
  </div>
</template>

<script setup lang="ts">
import { useCartStore } from "~/stores/cart";
import { money } from "~/utils/money";
import { cartLineMessage } from "~/utils/cart";
import { qtyText } from "~/utils/qty";

const cart = useCartStore();
const asset = useAsset();
const notice = useHeaderNotice();
const ready = computed(() => cart.quoteReady);

function setQty(id: number, qty: number) {
  if (cart.setQty(id, qty))
    notice.show({ target: 'cart', text: 'Количество обновлено' });
}

function remove(id: number) {
  cart.remove(id);
  notice.show({ target: 'cart', text: 'Удалено из корзины' });
}
</script>

<style scoped>
.cart-items {
  display: grid;
  gap: 1rem;
}

.item {
  display: grid;
  min-width: 0;
  grid-template-columns: 4.5rem minmax(0, 1fr);
  gap: 0.75rem;
  padding: 0.75rem;
  border: 1px solid var(--ui-border);
  border-radius: 1rem;
}

.item__img {
  display: grid;
  width: 100%;
  aspect-ratio: 1 / 1;
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
  min-width: 0;
  align-content: center;
  justify-items: start;
  gap: 0.75rem;
}

.item__title {
  font-size: 1.125rem;
  font-weight: 600;
  line-height: 1.35;
  overflow-wrap: anywhere;
}

.item__title:hover {
  color: var(--ui-primary);
}

.item__side {
  display: flex;
  justify-content: space-between;
  grid-column: 1 / -1;
  flex-direction: row;
  align-items: center;
}

.item :deep(button),
.item__remove {
  min-width: var(--touch-target);
  min-height: var(--touch-target);
}

.item__total {
  font-size: 1.125rem;
}

@media (min-width: 40rem) {
  .item {
    grid-template-columns: 7rem minmax(0, 1fr) auto;
    gap: 1.25rem;
    padding: 1rem;
  }

  .item__side {
    grid-column: auto;
    flex-direction: column;
    align-items: flex-end;
  }
}


</style>
