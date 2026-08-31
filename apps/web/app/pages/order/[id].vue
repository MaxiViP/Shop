<template>
  <UContainer class="order">
    <NuxtLink
      to="/orders"
      class="order__back"
    >
      ← Все заказы
    </NuxtLink>

    <header class="order__head">
      <div>
        <p class="order__number">
          Заказ №{{ order.id }}
        </p>

        <h1 class="order__title">
          {{ status.label }}
        </h1>
      </div>

      <OrderStatus :status="order.status" />
    </header>

    <section
      v-if="order.status !== 'CANCELED'"
      class="progress"
    >
      <div
        v-for="step in steps"
        :key="step.status"
        class="progress__item"
        :class="{
          'progress__item--done': step.done,
          'progress__item--current':
            step.status === order.status,
        }"
      >
        <span class="progress__dot" />

        <span class="progress__label">
          {{ step.label }}
        </span>
      </div>
    </section>

    <UAlert
      v-else
      color="error"
      variant="soft"
      title="Заказ отменён"
    />

    <div class="order__layout">
      <section class="card">
        <h2 class="card__title">
          Состав заказа
        </h2>

        <div
          v-for="item in order.items"
          :key="item.id"
          class="item"
        >
          <div>
            <strong>
              {{ item.productName }}
            </strong>

            <p class="item__qty">
              {{ qty(item) }}
            </p>
          </div>

          <strong>
            {{ money(item.total) }}
          </strong>
        </div>

        <div class="card__total">
          <span>
            Итого
          </span>

          <strong>
            {{ money(order.total) }}
          </strong>
        </div>
      </section>

      <section class="card">
        <h2 class="card__title">
          Получение
        </h2>

        <p>
          {{
            order.type === 'DELIVERY'
              ? 'Доставка'
              : 'Самовывоз'
          }}
        </p>

        <p
          v-if="address"
          class="card__muted"
        >
          {{ address }}
        </p>

        <p class="card__muted">
          {{ order.customerPhone }}
        </p>
      </section>
    </div>

    <p
      v-if="active"
      class="order__refresh"
    >
      Статус обновляется автоматически.
    </p>
  </UContainer>
</template>

<script setup lang="ts">
import type {
  OrderDetail,
  OrderStatus,
} from '~/types/order'
import {
  isActiveOrder,
  orderStatus,
} from '~/utils/order'
import { money } from '~/utils/money'

const route = useRoute()
const id = String(route.params.id)

const {
  data,
  error,
  refresh,
} = await useApi<OrderDetail>(
  `/orders/${id}`,
)

if (error.value || !data.value) {
  throw createError({
    statusCode: 404,
    statusMessage: 'Заказ не найден',
  })
}

const order = computed(
  () => data.value!,
)

const status = computed(
  () => orderStatus[order.value.status],
)

const active = computed(
  () => isActiveOrder(order.value.status),
)

const flow: OrderStatus[] = [
  'NEW',
  'CONFIRMED',
  'ASSEMBLING',
  'READY',
  'DELIVERING',
  'COMPLETED',
]

const steps = computed(() => {
  const current =
    flow.indexOf(order.value.status)

  return flow.map((item, index) => ({
    status: item,
    label: orderStatus[item].label,
    done: index <= current,
  }))
})

const address = computed(() =>
  [
    order.value.city,
    order.value.street,

    order.value.house
      ? `д. ${order.value.house}`
      : null,

    order.value.flat
      ? `кв. ${order.value.flat}`
      : null,
  ]
    .filter(Boolean)
    .join(', '),
)

function qty(
  item: OrderDetail['items'][number],
) {
  const value =
    item.actualQty ?? item.qty

  if (item.unit === 'GRAM') {
    return value >= 1000
      ? `${(value / 1000).toLocaleString(
          'ru-RU',
        )} кг`
      : `${value} г`
  }

  return `${value} шт.`
}

let timer: ReturnType<
  typeof setInterval
> | undefined

onMounted(() => {
  timer = setInterval(() => {
    if (active.value) {
      void refresh()
    }
  }, 15000)
})

onBeforeUnmount(() => {
  if (timer) {
    clearInterval(timer)
  }
})

useSeoMeta({
  title: () =>
    `Заказ №${order.value.id}`,
})
</script>

<style scoped>
.order {
  max-width: 960px;
  padding-block: 3rem 5rem;
}

.order__back {
  color: var(--ui-text-muted);
}

.order__back:hover {
  color: var(--ui-primary);
}

.order__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 2rem;
  margin-top: 2rem;
}

.order__number {
  color: var(--ui-primary);
  font-weight: 600;
}

.order__title {
  margin-top: 0.25rem;
  font-size: 2.5rem;
  font-weight: 700;
}

.progress {
  display: flex;
  margin-block: 3rem;
}

.progress__item {
  position: relative;
  display: grid;
  flex: 1;
  gap: 0.75rem;
  color: var(--ui-text-muted);
  font-size: 0.8rem;
}

.progress__item::before {
  position: absolute;
  top: 7px;
  right: 50%;
  left: -50%;
  height: 2px;
  background: var(--ui-border);
  content: '';
}

.progress__item:first-child::before {
  display: none;
}

.progress__dot {
  z-index: 1;
  width: 16px;
  height: 16px;
  border: 2px solid var(--ui-border);
  border-radius: 50%;
  background: var(--ui-bg);
}

.progress__item--done {
  color: var(--ui-text);
}

.progress__item--done::before {
  background: var(--ui-primary);
}

.progress__item--done .progress__dot {
  border-color: var(--ui-primary);
  background: var(--ui-primary);
}

.progress__item--current {
  font-weight: 700;
}

.order__layout {
  display: grid;
  grid-template-columns: 1.2fr 0.8fr;
  gap: 1rem;
}

.card {
  padding: 1.5rem;
  border: 1px solid var(--ui-border);
  border-radius: 1rem;
}

.card__title {
  margin-bottom: 1.25rem;
  font-size: 1.25rem;
  font-weight: 700;
}

.card__muted,
.item__qty {
  color: var(--ui-text-muted);
}

.card__muted {
  margin-top: 0.5rem;
}

.item {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  padding-block: 0.75rem;
}

.item__qty {
  margin-top: 0.25rem;
  font-size: 0.8rem;
}

.card__total {
  display: flex;
  justify-content: space-between;
  margin-top: 1rem;
  padding-top: 1rem;
  border-top: 1px solid var(--ui-border);
  font-size: 1.25rem;
}

.order__refresh {
  margin-top: 1rem;
  color: var(--ui-text-muted);
  font-size: 0.8rem;
}

@media (max-width: 700px) {
  .order__layout {
    grid-template-columns: 1fr;
  }

  .progress {
    overflow-x: auto;
  }

  .progress__item {
    min-width: 125px;
  }
}
</style>
