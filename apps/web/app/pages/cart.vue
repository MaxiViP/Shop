<template>
  <UContainer class="cart">
    <div class="cart__head">
      <h1 class="cart__title">Корзина</h1>

      <UButton
        v-if="cart.restored && cart.items.length"
        class="cart__clear"
        variant="ghost"
        color="neutral"
        @click="clearCart"
      >
        Очистить
      </UButton>
    </div>

    <UAlert v-if="cart.storageWarning" class="mb-4" color="warning" :title="cart.storageWarning" />
    <UAlert v-if="cart.priceChanged" class="mb-4" color="info" title="Цена некоторых товаров изменилась. Расчёт обновлён." />
    <UAlert v-if="quoteError || settingsError" class="mb-4" color="error" title="Не удалось обновить корзину" :description="quoteError || 'Не удалось загрузить способы получения.'" :actions="[{ label: 'Повторить', onClick: retry }]" />
    <div v-if="!cart.restored" role="status" aria-live="polite" class="space-y-4">
      <p>Восстанавливаем корзину…</p><USkeleton class="h-32 w-full" /><USkeleton class="h-32 w-full" />
    </div>
    <div v-else-if="cart.items.length" class="cart__layout">
      <div class="cart__items">
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
              v-else-if="ready && cart.quoteLine(item.product.id)?.product"
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
              aria-label="Удалить"
              @click="remove(item.product.id)"
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

        <div v-if="ready && cart.total !== null" class="summary__total">
          <span>Предварительно за товары</span>
          <strong>≈ {{ money(cart.total ?? 0) }}</strong>
        </div>

        <p v-else class="my-4 text-muted" role="status">{{ ready ? 'Исправьте отмеченные позиции для расчёта суммы.' : 'Проверяем товары и цены…' }}</p>
        <UAlert v-if="ready && cart.quote?.error === 'TOTAL_OVERFLOW'" class="mb-4" color="error" title="Сумма корзины слишком велика. Уменьшите количество или удалите позиции." />
        <OrderDeliveryMinimum v-if="ready && cart.total !== null" :settings="settings" :subtotal="cart.total" />
        <UButton to="/checkout" block size="lg" :disabled="!ready || !cart.quote?.valid || !settings || !!settingsError"> Оформить заказ </UButton>
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
import type { PublicShopSettings } from "~/utils/shop-settings";
import { cartLineMessage } from "~/utils/cart";
import { qtyText } from "~/utils/qty";
const { data: settings, error: settingsError, refresh: refreshSettings } = await useApi<PublicShopSettings>("/shop/settings");

const cart = useCartStore();
const asset = useAsset();
const notice = useHeaderNotice();
const { ready, error: quoteError, refresh: refreshQuote } = useCartQuote();
async function retry() { await Promise.all([refreshQuote(), refreshSettings()]); }

function setQty(id: number, qty: number) {
  const previous = cart.qty(id);
  cart.setQty(id, qty);
  if (cart.qty(id) !== previous) {
    notice.show({ target: 'cart', text: 'Количество обновлено' });
  }
}

function remove(id: number) {
  cart.remove(id);
  notice.show({ target: 'cart', text: 'Удалено из корзины' });
}

function clearCart() {
  cart.clear();
  notice.show({ target: 'cart', text: 'Корзина очищена' });
}

useSeoMeta({
  title: "Корзина",
});
</script>

<style scoped>
.cart {
  min-width: 0;
  padding-block: var(--page-start) var(--page-end);
}

.cart__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 2rem;
}

.cart__title {
  font-size: var(--page-title);
  font-weight: 700;
  line-height: 1.1;
}

.cart__layout {
  display: grid;
  min-width: 0;
  gap: 1.5rem;
}

.cart__items {
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

.cart__clear,
.item__remove {
  min-width: var(--touch-target);
  min-height: var(--touch-target);
}

.item__total {
  font-size: 1.125rem;
}

.summary {
  min-width: 0;
  align-self: start;
  padding: 1.5rem;
  border: 1px solid var(--ui-border);
  border-radius: 1rem;
}

.summary :deep(a),
.cart__empty :deep(a) {
  min-height: var(--touch-target);
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
  max-width: 26.25rem;
  margin: clamp(4rem, 12vw, 7rem) auto;
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

@media (min-width: 64rem) {
  .cart__layout {
    grid-template-columns: minmax(0, 1fr) minmax(20rem, 22.5rem);
    gap: 2rem;
  }

  .summary {
    align-self: start;
  }
}
</style>
