<template>
  <UContainer
    v-if="order"
    class="picking"
  >
    <NuxtLink
      to="/admin/orders"
      class="picking__back"
    >
      ← Все заказы
    </NuxtLink>

    <header class="picking__head">
      <div>
        <p class="picking__label">
          Заказ №{{ order.id }}
        </p>

        <h1 class="picking__title">
          Сборка заказа
        </h1>
      </div>

      <OrderStatus
        :status="order.status"
      />
    </header>

    <section class="customer">
      <div>
        <span class="customer__label">
          Покупатель
        </span>

        <strong>
          {{ order.customerName }}
        </strong>
      </div>

      <div>
        <span class="customer__label">
          Телефон
        </span>

        <strong>
          {{ order.customerPhone }}
        </strong>
      </div>

      <div v-if="address">
        <span class="customer__label">
          Адрес
        </span>

        <strong>
          {{ address }}
        </strong>
      </div>

      <div v-if="order.comment">
        <span class="customer__label">
          Комментарий
        </span>

        <strong>
          {{ order.comment }}
        </strong>
      </div>
    </section>

    <section class="picking__controls">
      <UButton
        v-if="order.status === 'NEW'"
        @click="changeStatus('CONFIRMED')"
      >
        Подтвердить заказ
      </UButton>

      <UButton
        v-if="order.status === 'CONFIRMED'"
        @click="changeStatus('ASSEMBLING')"
      >
        Начать сборку
      </UButton>

      <UButton
        v-if="order.status === 'ASSEMBLING'"
        :disabled="pending > 0"
        @click="changeStatus('READY')"
      >
        Завершить сборку
      </UButton>

      <UButton
        v-if="
          order.status === 'READY'
          && order.type === 'DELIVERY'
        "
        @click="changeStatus('DELIVERING')"
      >
        Передать курьеру
      </UButton>

      <UButton
        v-if="
          order.status === 'READY'
          && order.type === 'PICKUP'
        "
        @click="changeStatus('COMPLETED')"
      >
        Выдать покупателю
      </UButton>

      <UButton
        v-if="order.status === 'DELIVERING'"
        @click="changeStatus('COMPLETED')"
      >
        Доставлен
      </UButton>
    </section>

    <UAlert
      v-if="
        order.status === 'ASSEMBLING'
        && pending
      "
      color="warning"
      variant="soft"
      :title="
        `Осталось обработать: ${pending}`
      "
    />

    <section class="items">
      <article
        v-for="item in order.items"
        :key="item.id"
        class="item"
      >
        <div class="item__head">
          <div>
            <h2 class="item__name">
              {{ item.productName }}
            </h2>

            <p class="item__price">
              {{ price(item) }}
            </p>
          </div>

          <UBadge
            :color="
              item.status === 'PICKED'
                ? 'success'
                : item.status === 'MISSING'
                  ? 'error'
                  : 'neutral'
            "
            variant="soft"
          >
            {{ itemStatus(item.status) }}
          </UBadge>
        </div>

        <div class="item__stats">
          <div>
            <span>
              Заказано
            </span>

            <strong>
              {{ quantity(
                item.qty,
                item.unit,
              ) }}
            </strong>
          </div>

          <div>
            <span>
              Предварительно
            </span>

            <strong>
              {{ money(item.total) }}
            </strong>
          </div>

          <div
            v-if="
              item.actualQty !== null
            "
          >
            <span>
              Собрано
            </span>

            <strong>
              {{ quantity(
                item.actualQty,
                item.unit,
              ) }}
            </strong>
          </div>

          <div
            v-if="
              item.actualTotal !== null
            "
          >
            <span>
              Фактически
            </span>

            <strong>
              {{ money(
                item.actualTotal,
              ) }}
            </strong>
          </div>
        </div>

        <div
          v-if="
            order.status === 'ASSEMBLING'
          "
          class="item__actions"
        >
          <UFormField
            :label="
              item.unit === 'GRAM'
                ? 'Фактический вес, г'
                : 'Фактическое количество'
            "
          >
            <UInput
              v-model.number="
                actual[item.id]
              "
              type="number"
              min="1"
            />
          </UFormField>

          <UButton
            :loading="
              loadingItem === item.id
            "
            @click="pick(item.id)"
          >
            Собрано
          </UButton>

          <UButton
            color="error"
            variant="soft"
            :loading="
              loadingItem === item.id
            "
            @click="missing(item.id)"
          >
            Нет в наличии
          </UButton>
        </div>
      </article>
    </section>

    <section class="summary">
      <div class="summary__row">
        <span>
          Предварительная стоимость
        </span>

        <strong>
          {{ money(order.total) }}
        </strong>
      </div>

      <div
        v-if="
          order.finalTotal !== null
        "
        class="summary__row summary__row--total"
      >
        <span>
          Фактическая стоимость
        </span>

        <strong>
          {{ money(order.finalTotal) }}
        </strong>
      </div>
    </section>
  </UContainer>
</template>

<script setup lang="ts">
import type {
  AdminOrderDetail,
  OrderItemStatus,
  OrderStatus,
} from '~/types/order'
import { money } from '~/utils/money'

const route = useRoute()
const api = useApiClient()
const toast = useToast()

const id = Number(route.params.id)

const {
  data,
  error,
  refresh,
} = await useApi<AdminOrderDetail>(
  `/admin/orders/${id}`,
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

const actual = reactive<
  Record<number, number>
>({})

watch(
  () => order.value.items,
  items => {
    for (const item of items) {
      actual[item.id] =
        item.actualQty ?? item.qty
    }
  },
  {
    immediate: true,
  },
)

const loadingItem =
  ref<number | null>(null)

const statusLoading = ref(false)

const pending = computed(() =>
  order.value.items.filter(
    item =>
      item.status === 'PENDING',
  ).length,
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

async function pick(itemId: number) {
  const actualQty = actual[itemId]

  if (!actualQty || actualQty < 1) {
    toast.add({
      title:
        'Введите фактическое количество',
      color: 'error',
    })

    return
  }

  loadingItem.value = itemId

  try {
    await api(
      `/admin/orders/${id}/items/${itemId}`,
      {
        method: 'PATCH',

        body: {
          status: 'PICKED',
          actualQty,
        },
      },
    )

    await refresh()
  } finally {
    loadingItem.value = null
  }
}

async function missing(itemId: number) {
  loadingItem.value = itemId

  try {
    await api(
      `/admin/orders/${id}/items/${itemId}`,
      {
        method: 'PATCH',

        body: {
          status: 'MISSING',
        },
      },
    )

    await refresh()
  } finally {
    loadingItem.value = null
  }
}

async function changeStatus(
  status: OrderStatus,
) {
  statusLoading.value = true

  try {
    await api(
      `/admin/orders/${id}/status`,
      {
        method: 'PATCH',
        body: { status },
      },
    )

    await refresh()
  } finally {
    statusLoading.value = false
  }
}

function quantity(
  value: number,
  unit: string,
) {
  if (unit === 'GRAM') {
    if (value >= 1000) {
      return `${(
        value / 1000
      ).toLocaleString('ru-RU')} кг`
    }

    return `${value} г`
  }

  if (unit === 'BUNCH') {
    return `${value} пуч.`
  }

  if (unit === 'PACK') {
    return `${value} уп.`
  }

  return `${value} шт.`
}

function price(
  item: AdminOrderDetail['items'][number],
) {
  return `${money(item.price)} / ${
    item.unit === 'GRAM'
      ? quantity(
          item.priceQty,
          'GRAM',
        )
      : quantity(
          item.priceQty,
          item.unit,
        )
  }`
}

function itemStatus(
  status: OrderItemStatus,
) {
  return {
    PENDING: 'Не собрано',
    PICKED: 'Собрано',
    MISSING: 'Нет в наличии',
  }[status]
}

useSeoMeta({
  title: () =>
    `Сборка заказа №${order.value.id}`,
})
</script>

<style scoped>
.picking {
  max-width: 1000px;
  padding-block: 3rem 5rem;
}

.picking__back {
  color: var(--ui-text-muted);
}

.picking__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 2rem;
  margin-block: 2rem;
}

.picking__label {
  color: var(--ui-primary);
  font-weight: 600;
}

.picking__title {
  margin-top: 0.25rem;
  font-size: 2.5rem;
  font-weight: 700;
}

.picking__controls {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin-block: 1.5rem;
}

.customer {
  display: grid;
  grid-template-columns:
    repeat(
      auto-fit,
      minmax(180px, 1fr)
    );
  gap: 1rem;
  padding: 1.5rem;
  border: 1px solid var(--ui-border);
  border-radius: 1rem;
}

.customer > div {
  display: grid;
  gap: 0.25rem;
}

.customer__label {
  color: var(--ui-text-muted);
  font-size: 0.8rem;
}

.items {
  display: grid;
  gap: 1rem;
  margin-top: 2rem;
}

.item {
  display: grid;
  gap: 1.5rem;
  padding: 1.5rem;
  border: 1px solid var(--ui-border);
  border-radius: 1rem;
}

.item__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
}

.item__name {
  font-size: 1.25rem;
  font-weight: 700;
}

.item__price {
  margin-top: 0.25rem;
  color: var(--ui-text-muted);
}

.item__stats {
  display: grid;
  grid-template-columns:
    repeat(
      auto-fit,
      minmax(140px, 1fr)
    );
  gap: 1rem;
}

.item__stats div {
  display: grid;
  gap: 0.25rem;
}

.item__stats span {
  color: var(--ui-text-muted);
  font-size: 0.8rem;
}

.item__actions {
  display: flex;
  align-items: flex-end;
  flex-wrap: wrap;
  gap: 0.75rem;
  padding-top: 1rem;
  border-top: 1px solid var(--ui-border);
}

.summary {
  display: grid;
  gap: 1rem;
  margin-top: 2rem;
  padding: 1.5rem;
  border: 1px solid var(--ui-border);
  border-radius: 1rem;
}

.summary__row {
  display: flex;
  justify-content: space-between;
  gap: 2rem;
}

.summary__row--total {
  padding-top: 1rem;
  border-top: 1px solid var(--ui-border);
  font-size: 1.25rem;
}
</style>
