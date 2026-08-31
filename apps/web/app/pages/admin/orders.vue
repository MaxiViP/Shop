<template>
  <UContainer class="admin">
    <header class="admin__head">
      <div>
        <p class="admin__label">
          Управление
        </p>

        <h1 class="admin__title">
          Заказы
        </h1>
      </div>

      <UBadge>
        {{ active.length }} активных
      </UBadge>
    </header>

    <div class="admin__list">
      <article
        v-for="order in orders"
        :key="order.id"
        class="order"
      >
        <div class="order__head">
          <div>
            <NuxtLink
              :to="`/admin/orders/${order.id}`"
              class="order__number"
            >
              Заказ №{{ order.id }}
            </NuxtLink>

            <p class="order__date">
              {{ date(order.createdAt) }}
            </p>
          </div>

          <OrderStatus
            :status="order.status"
          />
        </div>

        <div class="order__customer">
          <strong>
            {{ order.customerName }}
          </strong>

          <span>
            {{ order.customerPhone }}
          </span>
        </div>

        <p
          v-if="address(order)"
          class="order__address"
        >
          {{ address(order) }}
        </p>

        <div class="order__items">
          <span
            v-for="item in order.items"
            :key="item.id"
          >
            {{ item.productName }}
          </span>
        </div>

        <strong class="order__total">
          {{ money(order.total) }}
        </strong>

        <div
          v-if="actions(order.status).length"
          class="order__actions"
        >
          <UButton
            v-for="action in actions(order.status)"
            :key="action.status"
            :color="
              action.status === 'CANCELED'
                ? 'error'
                : 'primary'
            "
            :variant="
              action.status === 'CANCELED'
                ? 'soft'
                : 'solid'
            "
            :loading="
              loadingId === order.id
            "
            @click="
              change(
                order.id,
                action.status,
              )
            "
          >
            {{ action.label }}
          </UButton>
        </div>
      </article>
    </div>
  </UContainer>
</template>

<script setup lang="ts">
import type {
  AdminOrder,
  OrderStatus,
} from '~/types/order'
import { useAuthStore } from '~/stores/auth'
import {
  isActiveOrder,
  orderStatus,
} from '~/utils/order'
import { money } from '~/utils/money'

const auth = useAuthStore()
const api = useApiClient()
const toast = useToast()

if (auth.user?.role !== 'ADMIN') {
  await navigateTo('/')
}

const {
  data,
  refresh,
} = await useApi<AdminOrder[]>(
  '/admin/orders',
  {
    default: () => [],
  },
)

const orders = computed(
  () => data.value ?? [],
)

const active = computed(() =>
  orders.value.filter(order =>
    isActiveOrder(order.status),
  ),
)

const loadingId = ref<number | null>(
  null,
)

const next: Partial<
  Record<OrderStatus, OrderStatus>
> = {
  NEW: 'CONFIRMED',
  CONFIRMED: 'ASSEMBLING',
  ASSEMBLING: 'READY',
  READY: 'DELIVERING',
  DELIVERING: 'COMPLETED',
}

function actions(status: OrderStatus) {
  if (
    status === 'COMPLETED'
    || status === 'CANCELED'
  ) {
    return []
  }

  const result: {
    status: OrderStatus
    label: string
  }[] = []

  const nextStatus = next[status]

  if (nextStatus) {
    result.push({
      status: nextStatus,
      label:
        orderStatus[nextStatus].label,
    })
  }

  if (status !== 'DELIVERING') {
    result.push({
      status: 'CANCELED',
      label: 'Отменить',
    })
  }

  return result
}

async function change(
  id: number,
  status: OrderStatus,
) {
  loadingId.value = id

  try {
    await api(
      `/admin/orders/${id}/status`,
      {
        method: 'PATCH',
        body: {
          status,
        },
      },
    )

    await refresh()

    toast.add({
      title:
        orderStatus[status].label,
    })
  } finally {
    loadingId.value = null
  }
}

function date(value: string) {
  return new Date(value)
    .toLocaleString('ru-RU', {
      dateStyle: 'medium',
      timeStyle: 'short',
    })
}

function address(order: AdminOrder) {
  return [
    order.city,
    order.street,

    order.house
      ? `д. ${order.house}`
      : null,
  ]
    .filter(Boolean)
    .join(', ')
}

useSeoMeta({
  title: 'Управление заказами',
})
</script>

<style scoped>
.admin {
  max-width: 1000px;
  padding-block: 3rem 5rem;
}

.admin__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 2rem;
  margin-bottom: 2rem;
}

.admin__label {
  color: var(--ui-primary);
  font-weight: 600;
}

.admin__title {
  margin-top: 0.25rem;
  font-size: 2.5rem;
  font-weight: 700;
}

.admin__list {
  display: grid;
  gap: 1rem;
}

.order {
  display: grid;
  gap: 1rem;
  padding: 1.5rem;
  border: 1px solid var(--ui-border);
  border-radius: 1rem;
}

.order__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
}

.order__number {
  font-size: 1.25rem;
  font-weight: 700;
}

.order__number:hover {
  color: var(--ui-primary);
}

.order__date,
.order__address {
  color: var(--ui-text-muted);
}

.order__date {
  margin-top: 0.25rem;
  font-size: 0.8rem;
}

.order__customer {
  display: flex;
  gap: 1rem;
}

.order__customer span {
  color: var(--ui-text-muted);
}

.order__items {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  color: var(--ui-text-muted);
}

.order__items span + span::before {
  margin-right: 0.5rem;
  content: '·';
}

.order__total {
  font-size: 1.25rem;
}

.order__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  padding-top: 1rem;
  border-top: 1px solid var(--ui-border);
}
</style>
