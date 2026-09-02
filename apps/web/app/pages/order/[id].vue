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
            {{ money(item.actualTotal ?? item.total) }}
          </strong>
        </div>

        <div class="card__summary">
          <div>
            <span>Товары</span>
            <strong>{{ money(order.finalSubtotal ?? order.subtotal) }}</strong>
          </div>

          <div v-if="order.type === 'DELIVERY'">
            <span>
              {{
                order.delivery?.provider === 'YANDEX'
                  ? 'Доставка Яндекс'
                  : 'Доставка'
              }}
            </span>
            <strong>{{ money(order.deliveryPrice) }}</strong>
          </div>

          <div class="card__total">
            <span>Итого</span>
            <strong>{{ money(order.finalTotal ?? order.total) }}</strong>
          </div>
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

      <section
        v-if="order.delivery"
        class="card card--delivery"
      >
        <h2 class="card__title">
          Доставка
        </h2>

        <dl class="delivery">
          <div>
            <dt>Сервис</dt>
            <dd>
              {{ deliveryProvider[order.delivery.provider] }}
            </dd>
          </div>

          <div>
            <dt>Статус</dt>
            <dd>
              {{ deliveryStatus[order.delivery.status] }}
            </dd>
          </div>

          <div v-if="order.delivery.externalOrderId">
            <dt>Номер доставки</dt>
            <dd>{{ order.delivery.externalOrderId }}</dd>
          </div>

          <div v-if="order.delivery.courierName">
            <dt>Курьер</dt>
            <dd>{{ order.delivery.courierName }}</dd>
          </div>

          <div v-if="order.delivery.courierPhone">
            <dt>Телефон курьера</dt>
            <dd>
              <a :href="`tel:${order.delivery.courierPhone}`">
                {{ order.delivery.courierPhone }}
              </a>
            </dd>
          </div>
        </dl>

        <UButton
          v-if="order.delivery.trackingUrl"
          class="delivery__action"
          :to="order.delivery.trackingUrl"
          target="_blank"
          rel="noopener noreferrer"
        >
          Отслеживать курьера
        </UButton>
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
import {
  deliveryProvider,
  deliveryStatus,
} from '~/utils/delivery'
import { money } from '~/utils/money'
import { qtyText } from '~/utils/qty'

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

const flow = computed<OrderStatus[]>(() =>
  order.value.type === 'DELIVERY'
    ? [
        'NEW',
        'CONFIRMED',
        'ASSEMBLING',
        'READY',
        'DELIVERING',
        'COMPLETED',
      ]
    : [
        'NEW',
        'CONFIRMED',
        'ASSEMBLING',
        'READY',
        'COMPLETED',
      ],
)

const steps = computed(() => {
  const current =
    flow.value.indexOf(order.value.status)

  return flow.value.map((item, index) => ({
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

  return qtyText(item.unit, value)
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
  max-width: 60rem;
  min-width: 0;
  padding-block: var(--page-start) var(--page-end);
}

.order__back {
  color: var(--ui-text-muted);
}

.order__back:hover {
  color: var(--ui-primary);
}

.order__head {
  display: grid;
  align-items: start;
  justify-content: space-between;
  gap: 1rem;
  margin-top: 2rem;
}

.order__number {
  color: var(--ui-primary);
  font-weight: 600;
}

.order__title {
  margin-top: 0.25rem;
  font-size: var(--page-title);
  font-weight: 700;
  line-height: 1.1;
  overflow-wrap: anywhere;
}

.progress {
  display: flex;
  max-width: 100%;
  margin-block: 3rem;
  padding-bottom: 0.5rem;
  overflow-x: auto;
  overscroll-behavior-inline: contain;
  scroll-snap-type: inline proximity;
  scrollbar-width: thin;
}

.progress__item {
  position: relative;
  display: grid;
  flex: 1;
  gap: 0.75rem;
  color: var(--ui-text-muted);
  font-size: 0.8rem;
  min-width: 7.75rem;
  scroll-snap-align: start;
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
  min-width: 0;
  gap: 1rem;
}

.card {
  min-width: 0;
  padding: var(--card-padding);
  border: 1px solid var(--ui-border);
  border-radius: 1rem;
}

.card--delivery {
  min-width: 0;
}

.card__title {
  margin-bottom: 1.25rem;
  font-size: var(--section-title);
  font-weight: 700;
}

.card__muted,
.item__qty {
  color: var(--ui-text-muted);
}

.card__muted {
  margin-top: 0.5rem;
  overflow-wrap: anywhere;
}

.delivery {
  display: grid;
  grid-template-columns: repeat(
    auto-fit,
    minmax(min(100%, 10rem), 1fr)
  );
  gap: 1rem;
}

.delivery > div {
  display: grid;
  gap: 0.25rem;
}

.delivery dt {
  color: var(--ui-text-muted);
  font-size: 0.8rem;
}

.delivery dd {
  font-weight: 600;
  overflow-wrap: anywhere;
}

.delivery__action {
  width: 100%;
  min-height: var(--touch-target);
  margin-top: 1.25rem;
  justify-content: center;
}

.item {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  padding-block: 0.75rem;
}

.item > * {
  min-width: 0;
  overflow-wrap: anywhere;
}

.item__qty {
  margin-top: 0.25rem;
  font-size: 0.8rem;
}

.card__summary {
  display: grid;
  gap: 0.75rem;
  margin-top: 1rem;
  padding-top: 1rem;
  border-top: 1px solid var(--ui-border);
}

.card__summary > div {
  display: grid;
  gap: 0.25rem;
}

.card__summary strong {
  overflow-wrap: anywhere;
}

.card__total {
  padding-top: 0.75rem;
  border-top: 1px solid var(--ui-border);
  font-size: 1.25rem;
}

.order__refresh {
  margin-top: 1rem;
  color: var(--ui-text-muted);
  font-size: 0.8rem;
}

@media (min-width: 40rem) {
  .order__head {
    display: flex;
    align-items: center;
  }

  .progress__item {
    min-width: 8rem;
  }

  .card__summary > div {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
  }

  .delivery__action {
    width: auto;
  }
}

@media (min-width: 48rem) {
  .order__layout {
    grid-template-columns: minmax(0, 1.2fr) minmax(0, 0.8fr);
  }

  .card--delivery {
    grid-column: 1 / -1;
  }
}
</style>
