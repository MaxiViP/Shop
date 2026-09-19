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
            Выбрано: {{ qtyText(item.product.unit, item.qty) }}. Минимум:
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

        <ProductQty
          v-else-if="!ready || cart.quoteLine(item.product.id)?.product"
          class="item__qty"
          :title="qtyText(item.product.unit, item.qty)"
          :model-value="item.qty"
          :product="item.product"
          @update:model-value="setQty(item.product.id, $event)"
        />

        <strong
          v-if="ready && cart.lineTotal(item) !== null"
          class="item__total"
          :title="money(cart.lineTotal(item) ?? 0)"
        >
          {{ money(cart.lineTotal(item) ?? 0) }}
        </strong>

        <UButton
          class="item__remove"
          :icon="
            countdowns[item.product.id] === undefined
              ? 'i-lucide-trash-2'
              : undefined
          "
          variant="ghost"
          color="neutral"
          :aria-label="
            (countdowns[item.product.id] === undefined
              ? 'Удалить из корзины: '
              : 'Отменить удаление: ') + item.product.name
          "
          @click="toggleRemoval(item.product.id)"
        >
          <span
            v-if="countdowns[item.product.id] !== undefined"
            class="item__countdown"
            role="status"
            >{{ countdowns[item.product.id] }}</span
          >
        </UButton>
      </div>
    </article>
  </div>
</template>

<script setup lang="ts">
import { useCartStore } from "~/stores/cart";
import { money } from "~/utils/money";
import { cartLineMessage, type CartItem } from "~/utils/cart";
import { qtyText } from "~/utils/qty";

const props = defineProps<{ disabled?: boolean }>();
const emit = defineEmits<{ removed: [item: CartItem] }>();
const countdowns = ref<Record<number, number>>({});
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const cart = useCartStore();
const asset = useAsset();
const notice = useHeaderNotice();
const ready = computed(() => cart.quoteReady);

function setQty(id: number, qty: number) {
  if (cart.setQty(id, qty))
    notice.show({ target: "cart", text: "Количество обновлено" });
}

function cancelRemoval(id: number) {
  clearTimeout(timers.get(id));
  timers.delete(id);
  Reflect.deleteProperty(countdowns.value, id);
}

function cancelAll() {
  for (const id of timers.keys()) cancelRemoval(id);
}

function toggleRemoval(id: number) {
  if (countdowns.value[id] !== undefined) {
    cancelRemoval(id);
    return;
  }
  if (props.disabled || !cart.items.some((item) => item.product.id === id))
    return;
  countdowns.value[id] = 5;
  function tick() {
    const remaining = countdowns.value[id];
    if (remaining === undefined) return;
    if (props.disabled) return cancelRemoval(id);
    if (remaining > 0) {
      countdowns.value[id] = remaining - 1;
      timers.set(id, setTimeout(tick, remaining === 1 ? 250 : 1000));
      return;
    }
    cancelRemoval(id);
    const item = cart.items.find((item) => item.product.id === id);
    if (!item) return;
    const removed = { product: item.product, qty: item.qty };
    cart.remove(id);
    emit("removed", removed);
    notice.show({ target: "cart", text: "Удалено из корзины" });
  }
  timers.set(id, setTimeout(tick, 1000));
}

watch(
  () => props.disabled,
  (value) => {
    if (value) cancelAll();
  },
  { flush: "sync" },
);
watch(
  () => cart.items.map((item) => item.product.id),
  (ids) => {
    for (const id of timers.keys()) if (!ids.includes(id)) cancelRemoval(id);
  },
  { flush: "sync" },
);
onBeforeUnmount(cancelAll);
</script>

<style scoped>
.item__countdown {
  color: var(--ui-error);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  animation: removal-blink 0.8s ease-in-out infinite;
}

@keyframes removal-blink {
  50% {
    opacity: 0.35;
  }
}

.cart-items {
  container: cart-items / inline-size;
  display: grid;
  gap: 0.5rem;
}

.item {
  display: grid;
  min-width: 0;
  grid-template-columns: 5rem minmax(0, 1fr);
  align-items: center;
  gap: 0.25rem;
  padding: 0.25rem;
  border: 1px solid var(--ui-border);
  border-radius: 0.75rem;
}

.item__img {
  display: grid;
  width: 5rem;
  height: 5rem;
  aspect-ratio: 1;
  place-items: center;
  overflow: hidden;
  border-radius: 0.5rem;
  background: var(--ui-bg-muted);
  color: var(--ui-text-muted);
}

.item__img img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.item__content {
  display: grid;
  min-width: 0;
  grid-template-columns: minmax(0, 1fr) auto;
  grid-template-rows: var(--touch-target) 1rem var(--touch-target);
  align-items: center;
  column-gap: 0.25rem;
}

.item__title {
  grid-area: 1 / 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.875rem;
  font-weight: 600;
  line-height: 1.25;
}

.item__title:hover {
  color: var(--ui-primary);
}

.item__img:focus-visible,
.item__title:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: 2px;
}

.item__price {
  grid-area: 2 / 1;
  min-width: 0;
  overflow: hidden;
  font-size: 0.75rem;
  line-height: 1rem;
  white-space: nowrap;
}

.item__price :deep(.price) {
  display: block;
  overflow: hidden;
  font-size: inherit;
  line-height: inherit;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.item__price :deep(.price__unit) {
  margin-inline-start: 0.125rem;
  font-size: inherit;
}

.item__total {
  grid-area: 2 / 2;
  min-width: 0;
  max-width: 6rem;
  justify-self: end;
  overflow: hidden;
  font-size: 0.875rem;
  font-variant-numeric: tabular-nums;
  line-height: 1rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.item__remove {
  grid-area: 1 / 2;
  justify-self: end;
}

.item__content > .item__qty {
  grid-area: 3 / 1 / auto / -1;
  display: grid;
  width: 100%;
  grid-template-columns: var(--touch-target) minmax(0, 1fr) var(--touch-target);
  gap: 0.125rem;
}

.item__qty :deep(.qty__value) {
  overflow: hidden;
  font-size: 0.8125rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.item__qty :deep(button),
.item__remove {
  width: var(--touch-target);
  height: var(--touch-target);
  min-width: var(--touch-target);
  min-height: var(--touch-target);
  padding: 0;
  justify-content: center;
}

.item__message,
.item__correction {
  grid-column: 1 / -1;
  min-width: 0;
  margin-top: 0.25rem;
  overflow-wrap: anywhere;
}

.item__message {
  grid-row: 4;
}

.item__correction {
  grid-row: 5;
  display: grid;
  gap: 0.25rem;
}

.item__correction :deep(button) {
  min-height: var(--touch-target);
  white-space: normal;
}

/* Two rows once the actual card width has room for price + quantity. */
@container cart-items (min-width: 19rem) {
  .item__content {
    grid-template-columns: minmax(0, 1fr) 6rem var(--touch-target);
    grid-template-rows: repeat(2, var(--touch-target));
    column-gap: 0.125rem;
  }

  .item__total {
    grid-area: 1 / 2;
  }

  .item__remove {
    grid-area: 1 / 3;
  }

  .item__content > .item__qty {
    grid-area: 2 / 2 / auto / 4;
  }

  .item__message {
    grid-row: 3;
  }

  .item__correction {
    grid-row: 4;
  }
}

/* The checkout summary can narrow this column even on a desktop viewport. */
@container cart-items (min-width: 40rem) {
  .item {
    gap: 0.5rem;
    padding: 0.5rem;
  }

  .item__content {
    grid-template-columns: minmax(0, 1fr) 6.5rem 9rem 6rem var(--touch-target);
    grid-template-rows: var(--touch-target);
    column-gap: 0.5rem;
  }

  .item__price {
    grid-area: 1 / 2;
  }

  .item__content > .item__qty {
    grid-area: 1 / 3;
  }

  .item__total {
    grid-area: 1 / 4;
  }

  .item__remove {
    grid-area: 1 / 5;
  }

  .item__message {
    grid-row: 2;
  }

  .item__correction {
    grid-row: 3;
  }
}
</style>
