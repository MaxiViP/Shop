<template>
  <NuxtLink
    :to="`/order/${order.publicId}`"
    class="order"
  >
    <div class="order__head">
      <div>
        <strong class="order__number">
          Заказ №{{ order.id }}
        </strong>

        <p class="order__date">
          {{ date }}
        </p>
      </div>

      <OrderStatus :status="order.status" :type="order.type" />
    </div>

    <p class="order__items">
      {{ products }}
    </p>
    <UBadge v-if="order.issues?.some(issue => issue.status === 'WAITING_CUSTOMER')" color="warning">Требуется ваше решение</UBadge>
    <UBadge v-if="order.customerUnread" color="info">Новых сообщений: {{ order.customerUnread }}</UBadge>

    <p v-if="order.type === 'PICKUP'" class="order__items">
      Самовывоз · {{ order.deliveryAt ? `К ${pickupTime(order.deliveryAt)} (МСК)` : 'Подготовим как можно скорее' }}
    </p>

    <strong class="order__total">
      Товары: {{ order.finalSubtotal === null ? '≈ ' : '' }}{{ knownMoney(order.finalSubtotal ?? order.subtotal) }}
    </strong>
    <p v-if="order.payment" class="order__items">{{ paymentLabels[order.payment.status] }}</p>
    <p v-if="order.type === 'DELIVERY'" class="order__items">Доставка оплачивается отдельно</p>
  </NuxtLink>
</template>

<script setup lang="ts">
import type { OrderSummary } from '~/types/order'
import { knownMoney } from '~/utils/money'
import { pickupTime } from '~/utils/pickup'

const { order } = defineProps<{
  order: OrderSummary
}>()

const date = computed(() =>
  new Date(order.createdAt)
    .toLocaleString('ru-RU', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }),
)

const products = computed(() =>
  order.items
    .map(item => item.productName)
    .join(', '),
)
</script>

<style scoped>
.order {
  display: grid;
  min-width: 0;
  gap: 1rem;
  padding: 1.25rem;
  border: 1px solid var(--ui-border);
  border-radius: 1rem;
  transition: border-color 0.2s;
}

.order:hover {
  border-color: var(--ui-primary);
}

.order__head {
  display: grid;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
}

.order__number {
  font-size: 1.125rem;
}

.order__date {
  margin-top: 0.25rem;
  color: var(--ui-text-muted);
  font-size: 0.8rem;
}

.order__items {
  color: var(--ui-text-muted);
  overflow-wrap: anywhere;
}

.order__total {
  font-size: 1.125rem;
}

@media (min-width: 40rem) {
  .order__head {
    display: flex;
  }
}
</style>
