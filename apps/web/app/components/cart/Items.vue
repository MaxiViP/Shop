<template>
  <div class="cart-items">
    <div v-for="item in cart.items" :key="item.product.id" class="cart-items__entry">
      <article class="item">
        <NuxtLink :to="`/product/${item.product.slug}`" class="item__img">
          <img
            v-if="item.product.images[0]"
            :src="asset(item.product.images[0].url)"
            :alt="item.product.images[0].alt || item.product.name"
          >

          <span v-else> Фото </span>
        </NuxtLink>

        <div class="item__content">
          <NuxtLink
            :to="`/product/${item.product.slug}`"
            class="item__title"
            :title="item.product.name"
          >
            {{ item.product.name }}
          </NuxtLink>

          <div class="item__price">
            <ProductPrice
              v-if="ready && cart.quoteLine(item.product.id)?.product"
              :product="item.product"
            />
            <span
              v-else-if="!ready"
              class="text-muted"
              role="status"
              aria-label="Проверяем цену"
              >…</span
            >
          </div>

          <ProductQty
            class="item__qty"
            :title="qtyText(item.quantityUnit ?? item.product.unit, item.qty, item.product)"
            :model-value="item.qty"
            :product="item.product"
            removable
            :disabled="disabled || cart.serverBusy"
            :remove-only="ready && cart.quoteLine(item.product.id)?.status !== 'AVAILABLE'"
            @update:model-value="setQty(item.product.id, $event)"
          >
            {{ qtyText(item.quantityUnit ?? item.product.unit, item.qty, item.product) }}
          </ProductQty>

          <strong
            v-if="ready && cart.lineTotal(item) !== null"
            class="item__total"
            :title="money(cart.lineTotal(item) ?? 0)"
          >
            {{ money(cart.lineTotal(item) ?? 0) }}
          </strong>
        </div>
      </article>
      <p v-if="variableWeight(item.product)" class="item__message text-muted">{{ item.product.unit === 'BUNCH' ? 'Пучки взвесят' : 'Продается целиком' }}. Вес и окончательную стоимость уточним при сборке.</p>
      <p v-else-if="item.product.unit === 'GRAM'" class="item__message text-muted">Стоимость может измениться после взвешивания.</p>

      <p
        v-if="ready && cartLineMessage(cart.quoteLine(item.product.id))"
        class="item__message text-error"
        role="alert"
      >
        {{ cartLineMessage(cart.quoteLine(item.product.id)) }}
      </p>
      <div
        v-if="
          ready &&
          cart.quoteLine(item.product.id)?.status === 'INVALID_QUANTITY'
        "
        class="item__correction"
      >
        <p class="text-muted">
          Выбрано: {{ qtyText(item.quantityUnit ?? item.product.unit, item.qty) }}. Минимум:
          {{ qtyText(item.product.unit, item.product.min) }}, шаг:
          {{ qtyText(item.product.unit, item.product.step) }}.
        </p>
        <UButton
          color="neutral"
          variant="soft"
          @click="setQty(item.product.id, item.product.min)"
          >Установить
          {{ qtyText(item.product.unit, item.product.min) }}</UButton
        >
      </div>

      <CartWeightLimits v-if="variableWeight(item.product)" :item="item" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { useCartStore } from "~/stores/cart";
import { money } from "~/utils/money";
import { cartLineMessage, type CartItem } from "~/utils/cart";
import { qtyText } from "~/utils/qty";
import { variableWeight } from '~/utils/sale';

const props = defineProps<{ disabled?: boolean }>();
const emit = defineEmits<{ remove: [item: CartItem] }>();
const cart = useCartStore();
const actions = useCartActions();
const asset = useAsset();
const notice = useHeaderNotice();
const ready = computed(() => cart.quoteReady);

async function setQty(id: number, qty: number) {
  if (props.disabled || cart.serverBusy) return;
  const item = cart.items.find(item => item.product.id === id);
  if (!item) return;
  const removed = { ...item };
  if (qty === 0) {
    emit("remove", removed);
  } else if (await actions.setQty(id, qty)) {
    notice.show({ target: "cart", text: "Количество обновлено" });
  }
}
</script>

<style scoped>
.cart-items {
  container: cart-items / inline-size;
  display: grid;
  gap: 0.5rem;
}
.cart-items__entry { min-width: 0; }
.item {
  display: grid;
  min-width: 0;
  grid-template-columns: 4rem minmax(0, 1fr);
  gap: 0.25rem;
  padding: 0.25rem;
  border: 1px solid var(--ui-border);
  border-radius: 0.75rem;
}
.item__img {
  display: grid;
  width: 4rem;
  height: 4rem;
  place-items: center;
  overflow: hidden;
  border-radius: 0.5rem;
  background: var(--ui-bg-muted);
  color: var(--ui-text-muted);
}
.item__img img { width: 100%; height: 100%; object-fit: cover; }
.item__content {
  display: grid;
  min-width: 0;
  grid-template-columns: minmax(0, 1fr) auto;
  grid-template-rows: 1.25rem var(--touch-target);
  align-items: center;
  column-gap: 0.25rem;
}
.item__title {
  grid-area: 1 / 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.8125rem;
  font-weight: 600;
  line-height: 1.25;
}
.item__title:hover { color: var(--ui-primary); }
.item__img:focus-visible, .item__title:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: 2px;
}
.item__price {
  grid-area: 1 / 2;
  min-width: 0;
  font-size: 0.6875rem;
  line-height: 1rem;
  white-space: nowrap;
}
.item__price :deep(.price) { font-size: inherit; line-height: inherit; }
.item__price :deep(.price__unit) { font-size: inherit; }
.item__total {
  grid-area: 2 / 2;
  justify-self: end;
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.item__content > .item__qty {
  grid-area: 2 / 1 / auto / -1;
  justify-self: start;
  display: grid;
  width: 7.25rem;
  max-width: none;
  grid-template-columns: 2rem 3.25rem 2rem;
  gap: 0;
}
.item__qty :deep(.qty__value) { font-size: 0.75rem; white-space: nowrap; overflow-wrap: normal; overflow: hidden; text-overflow: ellipsis; }
.item__qty :deep(button) {
  width: 2rem;
  min-width: 2rem;
  height: var(--touch-target);
  min-height: var(--touch-target);
  padding: 0;
  justify-content: center;
}
.item__message, .item__correction {
  margin: 0.25rem 0.25rem 0;
  font-size: 0.75rem;
  overflow-wrap: anywhere;
}
.item__correction { display: grid; gap: 0.25rem; }
.item__correction :deep(button) { min-height: var(--touch-target); white-space: normal; }
@container cart-items (min-width: 19rem) {
  .item { grid-template-columns: 5rem minmax(0, 1fr); gap: 0.5rem; }
  .item__img { width: 5rem; height: 5rem; }
  .item__content { grid-template-rows: 2.25rem var(--touch-target); }
  .item__title { font-size: 0.875rem; }
  .item__price { font-size: 0.75rem; }
  .item__total { font-size: 0.875rem; }
  .item__content > .item__qty { width: 9rem; grid-template-columns: var(--touch-target) 3.5rem var(--touch-target); }
  .item__qty :deep(button) { width: var(--touch-target); min-width: var(--touch-target); }
}
</style>
