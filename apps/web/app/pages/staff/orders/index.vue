<template>
  <UContainer class="queue">
    <header class="queue__head">
      <div>
        <p class="queue__label">Рабочее место продавца</p>
        <h1 class="queue__title">Очередь заказов</h1>
      </div>

      <UBadge size="lg">{{ activeCount }} активных</UBadge>
    </header>

    <nav class="queue__tabs" aria-label="Фильтр заказов">
      <UButton
        v-for="filter in filters"
        :key="filter.value"
        :variant="activeFilter === filter.value ? 'solid' : 'soft'"
        :color="activeFilter === filter.value ? 'primary' : 'neutral'"
        @click="activeFilter = filter.value"
      >
        {{ filter.label }}
        <UBadge
          :color="activeFilter === filter.value ? 'neutral' : 'primary'"
          variant="subtle"
        >
          {{ count(filter.statuses) }}
        </UBadge>
      </UButton>
    </nav>

    <div v-if="visibleOrders.length" class="queue__list">
      <article
        v-for="order in visibleOrders"
        :key="order.id"
        class="order-card"
      >
        <header class="order-card__head">
          <div>
            <NuxtLink
              :to="`/staff/orders/${order.id}`"
              class="order-card__number"
            >
              Заказ №{{ order.id }}
            </NuxtLink>

            <p class="order-card__created">
              Создан {{ date(order.createdAt) }}
            </p>
          </div>

          <OrderStatus :status="order.status" />
        </header>

        <div class="order-card__meta">
          <UBadge color="neutral" variant="soft">
            {{ order.type === 'DELIVERY' ? 'Доставка' : 'Самовывоз' }}
          </UBadge>

          <UBadge
            v-if="order.type === 'DELIVERY'"
            :color="order.delivery ? 'info' : 'warning'"
            variant="soft"
          >
            {{
              order.delivery
                ? deliveryStatus[order.delivery.status]
                : 'Доставка не оформлена'
            }}
          </UBadge>
        </div>

        <dl class="order-card__details">
          <div>
            <dt>Желаемое время</dt>
            <dd>
              {{ order.deliveryAt ? date(order.deliveryAt) : 'Не указано' }}
            </dd>
          </div>

          <div>
            <dt>Покупатель</dt>
            <dd>{{ order.customerName }}</dd>
          </div>

          <div>
            <dt>Телефон</dt>
            <dd>
              <a :href="`tel:${order.customerPhone}`">
                {{ order.customerPhone }}
              </a>
            </dd>
          </div>

          <div v-if="address(order)">
            <dt>Адрес</dt>
            <dd>{{ address(order) }}</dd>
          </div>

          <div>
            <dt>Товарных позиций</dt>
            <dd>{{ order.items.length }}</dd>
          </div>

          <div>
            <dt>
              {{ order.finalTotal === null ? 'Предварительный итог' : 'Итог' }}
            </dt>
            <dd>{{ money(order.finalTotal ?? order.total) }}</dd>
          </div>
        </dl>

        <footer v-if="operational(order.status)" class="order-card__actions">
          <UButton
            v-if="order.status === 'NEW'"
            size="lg"
            :loading="loading === key(order.id, 'confirm')"
            :disabled="busy(order.id)"
            @click="confirm(order.id)"
          >
            Подтвердить
          </UButton>

          <UButton
            v-if="order.status === 'CONFIRMED'"
            size="lg"
            :loading="loading === key(order.id, 'assembly')"
            :disabled="busy(order.id)"
            @click="startAssembly(order.id)"
          >
            Начать сборку
          </UButton>

          <UButton
            v-if="order.status === 'ASSEMBLING'"
            type="button"
            size="lg"
            @click="openOrder(order.id)"
          >
            Продолжить сборку
          </UButton>

          <UButton
            v-if="order.status === 'READY' && order.type === 'PICKUP'"
            size="lg"
            :loading="loading === key(order.id, 'pickup')"
            :disabled="busy(order.id)"
            @click="completePickup(order.id)"
          >
            Выдать покупателю
          </UButton>

          <UButton
            v-if="order.status === 'READY' && order.type === 'DELIVERY'"
            type="button"
            size="lg"
            @click="openOrder(order.id, '#delivery')"
          >
            {{ order.delivery ? 'Открыть доставку' : 'Оформить доставку' }}
          </UButton>

          <UButton
            v-if="
              order.status === 'DELIVERING' &&
              order.delivery?.provider === 'OTHER'
            "
            size="lg"
            :loading="loading === key(order.id, 'delivered')"
            :disabled="busy(order.id)"
            @click="completeDelivery(order.id)"
          >
            Доставлен
          </UButton>

          <UButton
            v-else-if="
              order.status === 'DELIVERING' &&
              order.delivery?.provider === 'YANDEX'
            "
            :to="`/staff/orders/${order.id}#delivery`"
            size="lg"
            variant="soft"
          >
            Открыть доставку
          </UButton>

          <UButton
            v-if="cancelable(order.status)"
            size="lg"
            color="error"
            variant="soft"
            :loading="loading === key(order.id, 'cancel')"
            :disabled="busy(order.id)"
            @click="cancel(order.id)"
          >
            Отменить заказ
          </UButton>
        </footer>
      </article>
    </div>

    <div v-else class="queue__empty">
      <UIcon name="i-lucide-clipboard-check" class="queue__empty-icon" />
      <strong>В этой очереди заказов нет</strong>
    </div>
  </UContainer>
</template>

<script setup lang="ts">
import type { OrderStatus, StaffOrder } from '~/types/order'
import { useAuthStore } from '~/stores/auth'
import { apiError } from '~/utils/api-error'
import { deliveryStatus } from '~/utils/delivery'
import { isActiveOrder } from '~/utils/order'
import { money } from '~/utils/money'

type FilterValue =
  'new' | 'confirmed' | 'assembling' | 'ready' | 'delivering' | 'finished'

interface QueueFilter {
  value: FilterValue
  label: string
  statuses: OrderStatus[]
}

const filters: QueueFilter[] = [
  { value: 'new', label: 'Новые', statuses: ['NEW'] },
  { value: 'confirmed', label: 'К сборке', statuses: ['CONFIRMED'] },
  { value: 'assembling', label: 'Сборка', statuses: ['ASSEMBLING'] },
  { value: 'ready', label: 'Готовы', statuses: ['READY'] },
  { value: 'delivering', label: 'В пути', statuses: ['DELIVERING'] },
  {
    value: 'finished',
    label: 'Завершённые',
    statuses: ['COMPLETED', 'CANCELED'],
  },
]

const auth = useAuthStore()
const api = useApiClient()
const toast = useToast()

if (auth.user?.role !== 'SELLER' && auth.user?.role !== 'ADMIN') {
  await navigateTo('/')
}

const { data, error, refresh } = await useApi<StaffOrder[]>('/staff/orders', {
  default: () => [],
})

if (error.value) {
  toast.add({
    title: 'Не удалось загрузить заказы',
    description: apiError(error.value),
    color: 'error',
  })
}

const activeFilter = ref<FilterValue>('new')
const loading = ref<string | null>(null)

const orders = computed(() => data.value ?? [])

const activeCount = computed(
  () => orders.value.filter((order) => isActiveOrder(order.status)).length,
)

const visibleOrders = computed(() => {
  const filter = filters.find((item) => item.value === activeFilter.value)!
  const result = orders.value.filter((order) =>
    filter.statuses.includes(order.status),
  )

  if (activeFilter.value === 'finished') {
    return result.sort(
      (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
    )
  }

  return result.sort((a, b) => {
    const deliveryDifference = queueTime(a) - queueTime(b)

    return (
      deliveryDifference || Date.parse(a.createdAt) - Date.parse(b.createdAt)
    )
  })
})

function count(statuses: OrderStatus[]) {
  return orders.value.filter((order) => statuses.includes(order.status)).length
}

function queueTime(order: StaffOrder) {
  return order.deliveryAt
    ? Date.parse(order.deliveryAt)
    : Number.MAX_SAFE_INTEGER
}

function key(id: number, action: string) {
  return `${id}:${action}`
}

function busy(id: number) {
  return loading.value?.startsWith(`${id}:`) ?? false
}

function operational(status: OrderStatus) {
  return status !== 'COMPLETED' && status !== 'CANCELED'
}

function cancelable(status: OrderStatus) {
  return ['NEW', 'CONFIRMED', 'ASSEMBLING', 'READY'].includes(status)
}

async function action(id: number, name: string, path: string, success: string) {
  loading.value = key(id, name)

  try {
    await api(`/staff/orders/${id}/${path}`, {
      method: 'POST',
    })

    await refresh()
    toast.add({ title: success })

    return true
  } catch (error) {
    toast.add({
      title: 'Не удалось выполнить действие',
      description: apiError(error),
      color: 'error',
    })

    return false
  } finally {
    loading.value = null
  }
}

async function confirm(id: number) {
  await action(id, 'confirm', 'confirm', 'Заказ подтверждён')
}

async function startAssembly(id: number) {
  const changed = await action(
    id,
    'assembly',
    'assembly/start',
    'Сборка начата',
  )

  if (changed) {
    await openOrder(id)
  }
}

async function openOrder(id: number, hash?: string) {
  try {
    await navigateTo({
      path: `/staff/orders/${id}`,
      ...(hash ? { hash } : {}),
    })
  } catch (error) {
    toast.add({
      title: 'Не удалось открыть заказ',
      description: apiError(error),
      color: 'error',
    })
  }
}

async function completePickup(id: number) {
  await action(id, 'pickup', 'pickup/complete', 'Заказ выдан покупателю')
}

async function completeDelivery(id: number) {
  await action(id, 'delivered', 'delivery/complete', 'Доставка завершена')
}

async function cancel(id: number) {
  await action(id, 'cancel', 'cancel', 'Заказ отменён')
}

function date(value: string) {
  return new Date(value).toLocaleString('ru-RU', {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

function address(order: StaffOrder) {
  return [order.city, order.street, order.house ? `д. ${order.house}` : null]
    .filter(Boolean)
    .join(', ')
}

useSeoMeta({
  title: 'Очередь заказов',
})
</script>

<style scoped>
.queue {
  max-width: 1100px;
  padding-block: 2rem 5rem;
}

.queue__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

.queue__label {
  color: var(--ui-primary);
  font-weight: 600;
}

.queue__title {
  margin-top: 0.25rem;
  font-size: clamp(2rem, 6vw, 2.75rem);
  font-weight: 700;
}

.queue__tabs {
  display: flex;
  overflow-x: auto;
  gap: 0.5rem;
  margin-block: 2rem;
  padding-bottom: 0.5rem;
}

.queue__tabs > * {
  flex: 0 0 auto;
}

.queue__list {
  display: grid;
  gap: 1rem;
}

.queue__empty {
  display: grid;
  padding: 4rem 1rem;
  place-items: center;
  gap: 0.75rem;
  border: 1px dashed var(--ui-border);
  border-radius: 1rem;
  color: var(--ui-text-muted);
}

.queue__empty-icon {
  width: 3rem;
  height: 3rem;
}

.order-card {
  display: grid;
  gap: 1.25rem;
  padding: 1.5rem;
  border: 1px solid var(--ui-border);
  border-radius: 1rem;
}

.order-card__head,
.order-card__meta,
.order-card__actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.75rem;
}

.order-card__head {
  align-items: flex-start;
  justify-content: space-between;
}

.order-card__number {
  font-size: 1.25rem;
  font-weight: 700;
}

.order-card__number:hover {
  color: var(--ui-primary);
}

.order-card__created,
.order-card__details dt {
  color: var(--ui-text-muted);
  font-size: 0.8rem;
}

.order-card__created {
  margin-top: 0.25rem;
}

.order-card__details {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(155px, 1fr));
  gap: 1rem;
}

.order-card__details > div {
  display: grid;
  align-content: start;
  gap: 0.25rem;
}

.order-card__details dd {
  font-weight: 600;
}

.order-card__actions {
  padding-top: 1rem;
  border-top: 1px solid var(--ui-border);
}

@media (max-width: 640px) {
  .queue__head {
    align-items: flex-start;
  }

  .order-card {
    padding: 1.25rem;
  }

  .order-card__actions > * {
    width: 100%;
    justify-content: center;
  }
}
</style>
