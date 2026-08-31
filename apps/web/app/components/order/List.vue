<template>
  <div class="orders">
    <section
      v-if="current.length"
      class="orders__section"
    >
      <h2 class="orders__title">
        Текущие заказы
      </h2>

      <div class="orders__list">
        <OrderCard
          v-for="order in current"
          :key="order.id"
          :order="order"
        />
      </div>
    </section>

    <section
      v-if="history.length"
      class="orders__section"
    >
      <h2 class="orders__title">
        История заказов
      </h2>

      <div class="orders__list">
        <OrderCard
          v-for="order in history"
          :key="order.id"
          :order="order"
        />
      </div>
    </section>

    <div
      v-if="!orders.length"
      class="orders__empty"
    >
      <UIcon
        name="i-lucide-package"
        class="orders__icon"
      />

      <strong>
        Заказов пока нет
      </strong>

      <p>
        Здесь появятся ваши текущие
        и завершённые заказы.
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { OrderSummary } from '~/types/order'
import { isActiveOrder } from '~/utils/order'

const {
  data,
  refresh,
} = await useApi<OrderSummary[]>(
  '/orders',
  {
    default: () => [],
  },
)

const orders = computed(
  () => data.value ?? [],
)

const current = computed(() =>
  orders.value.filter(order =>
    isActiveOrder(order.status),
  ),
)

const history = computed(() =>
  orders.value.filter(order =>
    !isActiveOrder(order.status),
  ),
)

let timer: ReturnType<
  typeof setInterval
> | undefined

onMounted(() => {
  timer = setInterval(() => {
    if (current.value.length) {
      void refresh()
    }
  }, 15000)
})

onBeforeUnmount(() => {
  if (timer) {
    clearInterval(timer)
  }
})
</script>

<style scoped>
.orders__section + .orders__section {
  margin-top: 3rem;
}

.orders__title {
  margin-bottom: 1rem;
  font-size: 1.5rem;
  font-weight: 700;
}

.orders__list {
  display: grid;
  gap: 1rem;
}

.orders__empty {
  display: grid;
  padding: 3rem;
  justify-items: center;
  gap: 0.75rem;
  border: 1px dashed var(--ui-border);
  border-radius: 1rem;
  text-align: center;
}

.orders__empty p {
  color: var(--ui-text-muted);
}

.orders__icon {
  width: 2.5rem;
  height: 2.5rem;
  color: var(--ui-text-muted);
}
</style>
