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

      <OrderStatus :status="order.status" />
    </div>

    <p class="order__items">
      {{ products }}
    </p>

    <strong class="order__total">
      {{ money(order.total) }}
    </strong>
  </NuxtLink>
</template>

<script setup lang="ts">
import type { OrderSummary } from '~/types/order'
import { money } from '~/utils/money'

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
