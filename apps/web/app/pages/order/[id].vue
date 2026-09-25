<template>
  <UContainer class="order">
    <AppBackButton fallback="/orders" label="К заказам" />

    <template v-if="order">

    <header class="order__head">
      <div>
        <p class="order__number">
          Заказ №{{ order.id }}
        </p>

        <h1 class="order__title">
          {{ status.label }}
        </h1>
      </div>

      <OrderStatus :status="order.status" :type="order.type" />
    </header>

    <OrderProgress :status="order.status" :type="order.type" />

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
              Заказано: {{ qtyText(item.unit, item.qty) }}
              <span v-if="item.actualQty !== null"> · Собрано: {{ qty(item) }}</span>
            </p>
          </div>

          <strong>
            {{ money(item.actualTotal ?? item.total) }}
          </strong>
        </div>

        <div class="card__summary">
          <div>
            <span>Предварительная стоимость товаров</span>
            <strong>≈ {{ money(order.subtotal) }}</strong>
          </div>

          <div v-if="order.type === 'DELIVERY'">
            <span>
              {{
                order.delivery?.provider === 'YANDEX'
                  ? 'Доставка Яндекс'
                  : 'Доставка'
              }}
            </span>
            <strong>{{ knownMoney(order.deliveryPrice) }}</strong>
          </div>

          <div class="card__total">
            <span>{{ order.assemblyFinalizedAt ? 'Фактическая стоимость товаров и услуг' : 'Оплата после сборки' }}</span>
            <strong v-if="order.assemblyFinalizedAt">{{ knownMoney(order.finalSubtotal) }}</strong>
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
          v-if="order.type === 'DELIVERY' && address"
          class="card__muted"
        >
          {{ address }}
        </p>

        <template v-if="order.type === 'PICKUP'">
          <p class="card__muted">{{ order.deliveryAt ? `Ко времени ${pickupTime(order.deliveryAt)} (МСК)` : 'Собирать сразу' }}</p>
          <OrderPickupPoint />
        </template>

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

    <p v-if="!order.assemblyFinalizedAt && order.status !== 'CANCELED'" class="my-4 text-muted">Мы соберём и взвесим товары. После сборки здесь появится точная сумма для оплаты.</p>
    <p v-if="order.type === 'DELIVERY'" class="my-4 text-muted">Доставка оплачивается отдельно и не входит в перевод магазину за товары.</p>
    <OrderExtras v-if="order.assemblyFinalizedAt" :extras="order.extras ?? []" />
    <OrderPayment :order="order" />
    <OrderCoordination :key="order.publicId" :base="`/orders/${order.publicId}`" :bps="order.weightToleranceBps" :assembling="order.status === 'ASSEMBLING'" @refresh="refresh" />

    <p
      v-if="active"
      class="order__refresh"
    >
      Статус обновляется автоматически.
    </p>
    </template>

    <section v-else class="order__sign-in">
      <h1 class="order__title">{{ loadingAfterLogin ? "Загружаем заказ…" : "Войдите, чтобы открыть заказ" }}</h1>
      <p v-if="!loadingAfterLogin" class="card__muted">Войдите через Telegram или подтвердите телефон. После входа заказ откроется здесь.</p>
      <UButton v-if="!loadingAfterLogin" size="lg" @click="loginOpen = true">Войти</UButton>
    </section>
    <AuthModal v-model:open="loginOpen" />
  </UContainer>
</template>

<script setup lang="ts">
import type {
  OrderDetail,
} from '~/types/order'
import {
  isActiveOrder,
  orderMeta,
} from '~/utils/order'
import {
  deliveryProvider,
  deliveryStatus,
} from '~/utils/delivery'
import { knownMoney, money } from '~/utils/money'
import { qtyText } from '~/utils/qty'
import { pickupTime } from '~/utils/pickup'

const route = useRoute()
const auth = useAuthStore()
const loginOpen = ref(false)
const loadingAfterLogin = ref(false)
const id = String(route.params.id)

const {
  data,
  error,
  refresh,
} = await useApi<OrderDetail>(
  `/orders/${id}`,
)

const missing = error.value?.statusCode === 404 || error.value?.statusCode === 403
const signIn = !auth.user && (missing || error.value?.statusCode === 401)
if ((error.value && !signIn) || (!data.value && !error.value)) {
  throw createError({
    statusCode: missing ? 404 : 503,
    statusMessage: missing ? 'Заказ не найден' : 'Не удалось загрузить заказ',
  })
}

watch(() => auth.user?.id, async userId => {
  if (!userId || data.value) return
  loadingAfterLogin.value = true
  try {
    await refresh()
    if (error.value || !data.value) {
      const notFound = error.value?.statusCode === 404 || error.value?.statusCode === 403
      showError(createError({
        statusCode: notFound ? 404 : 503,
        statusMessage: notFound ? 'Заказ не найден' : 'Не удалось загрузить заказ',
      }))
    }
  } finally { loadingAfterLogin.value = false }
})

const order = computed(
  () => data.value!,
)

const status = computed(
  () => orderMeta(order.value.status, order.value.type),
)

const active = computed(
  () => isActiveOrder(order.value.status),
)


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
  if (signIn) loginOpen.value = true
  timer = setInterval(() => {
    if (order.value && document.visibilityState === 'visible' && (active.value || order.value.status === 'CANCELED')) {
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
    `Заказ №${order.value?.id ?? ""}`,
})
</script>

<style scoped>
.order {
  max-width: 60rem;
  min-width: 0;
  padding-block: var(--page-start) var(--page-end);
}

.order__sign-in {
  display: grid;
  justify-items: start;
  gap: 1rem;
  margin-top: var(--card-padding);
}

.order__head {
  display: grid;
  align-items: start;
  justify-content: space-between;
  gap: 1rem;
  margin-top: var(--card-padding);
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
  font-size: 0.875rem;
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
  font-size: 0.875rem;
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
  font-size: 0.875rem;
}

@media (min-width: 40rem) {
  .order__head {
    display: flex;
    align-items: center;
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
