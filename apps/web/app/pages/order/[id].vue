<template>
  <UContainer class="order">
    <AppBackButton fallback="/orders" label="К заказам" />

    <template v-if="order">

    <header class="order__head">
      <div>
        <h1 class="order__title">Заказ №{{ order.id }}</h1>
        <p class="order__quick">{{ order.items.length }} позиций · {{ order.type === 'DELIVERY' ? 'Доставка' : 'Самовывоз' }}</p>
      </div>
      <div class="order__headline">
        <OrderStatus :status="order.status" :type="order.type" />
        <strong>{{ knownMoney(order.finalTotal ?? order.total, 'Не рассчитано') }}</strong>
      </div>
    </header>

    <OrderProgress :status="order.status" :type="order.type" />
    <section v-if="['NEW', 'CONFIRMED'].includes(order.status)" class="order-queue" aria-live="polite">
      <template v-if="order.fulfillmentMode === 'SCHEDULED' && order.scheduledFor">
        <strong>Предзаказ · подготовим к {{ slotLabel(order.scheduledFor) }} (МСК)</strong>
        <p>Время ориентировочное. Заказ появится у продавца заранее.</p>
      </template>
      <template v-else-if="order.queue?.position">
        <strong>Вы примерно {{ order.queue.position }}-й в очереди</strong>
        <p v-if="order.queue.wait">Ориентировочное начало сборки через {{ order.queue.wait.min }}–{{ order.queue.wait.max }} минут.</p>
      </template>
      <UButton
        v-if="order.fulfillmentMode === 'SCHEDULED' || order.queue?.showScheduledOffer"
        type="button" variant="soft" size="sm" @click="openSchedule">
        {{ order.fulfillmentMode === 'SCHEDULED' ? 'Изменить время' : 'Выбрать время' }}
      </UButton>
      <div v-if="scheduleOpen" class="order-queue__edit">
        <label for="order-slot">Подготовить к (Москва)</label>
        <select id="order-slot" v-model="selectedSlot" class="order-queue__select" :disabled="scheduleBusy">
          <option value="">Выберите доступное время</option>
          <option v-for="slot in scheduleOptions?.slots ?? []" :key="slot.at" :value="slot.at">{{ slotLabel(slot.at) }}</option>
        </select>
        <p v-if="scheduleOptions && !scheduleOptions.slots.length" class="text-muted">Свободных слотов сейчас нет. Попробуйте позже.</p>
        <div class="order-queue__actions">
          <UButton type="button" size="sm" :disabled="!selectedSlot || scheduleBusy" :loading="scheduleBusy" @click="saveSchedule">Сохранить</UButton>
          <UButton v-if="order.fulfillmentMode === 'SCHEDULED'" type="button" size="sm" variant="soft" :disabled="scheduleBusy" @click="saveAsap">Как можно скорее</UButton>
        </div>
        <p v-if="scheduleError" role="alert" class="text-error">{{ scheduleError }}</p>
      </div>
    </section>
    <OrderSections :links="customerSections" initial-hash="#order-items" />

    <div class="order__layout">
      <section id="order-items" class="card">
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
            <p v-if="replacementIds.has(item.id)" class="item__state">🔁 Замена исходного товара</p>
            <p class="item__qty">Заказано: {{ qtyText(item.unit, item.qty) }}</p>
            <p v-if="item.actualPrice !== null && item.actualPrice !== item.price" class="item__price-change">Цена изменена: {{ money(item.price) }} → {{ money(item.actualPrice) }} / {{ qtyText(item.unit, item.priceQty) }}</p>
            <p v-if="item.status === 'MISSING'" class="item__state">❌ Нет в наличии</p>
            <p v-else-if="item.status === 'PICKED' && item.actualQty !== null" class="item__state">
              Собрано: {{ qtyText(item.unit, item.actualQty) }}
            </p>
            <p v-if="proposal(item.id)" class="item__state">
              {{ proposal(item.id) }}
            </p>
          </div>

          <strong v-if="item.status !== 'MISSING'">
            {{ item.status === 'PICKED' && item.actualTotal !== null ? money(item.actualTotal) : `≈ ${money(item.total)}` }}
          </strong>
        </div>

        <OrderCosts v-if="order.promoCodeSnapshot" id="order-summary" :order="order" />
        <div v-else id="order-summary" class="card__summary">
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
            <strong>{{ deliveryCost(order.deliveryPrice) }}</strong>
          </div>

          <div class="card__total">
            <span>{{ order.assemblyFinalizedAt ? 'Фактическая стоимость товаров и услуг' : 'Оплата после сборки' }}</span>
            <strong v-if="order.assemblyFinalizedAt">{{ knownMoney(order.finalSubtotal) }}</strong>
          </div>
        </div>
      </section>

      <section id="order-receiving" class="card">
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

    <p v-if="order.status === 'ASSEMBLING'" class="order__note">Фактический вес, услуги и изменения цены войдут в итог после сборки. Предварительная сумма выше рассчитана по цене заказа.</p>
    <p v-else-if="!order.assemblyFinalizedAt && order.status !== 'CANCELED'" class="order__note">Мы соберём и взвесим товары. После сборки здесь появится точная сумма для оплаты.</p>
    <p class="order__note">{{ orderDeliveryMessage(order) }}</p>
    <OrderExtras :extras="order.extras ?? []" />
    <OrderPayment :order="order" />
    <OrderCoordination :key="order.publicId" :base="`/orders/${order.publicId}`" :bps="order.weightToleranceBps" :assembling="order.status === 'ASSEMBLING'" :has-issues="order.issues.length > 0" :poll="active" @refresh="refreshOrder" />

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
import { formatAddress } from "~/utils/address";
import type { OrderDetail, QueueOffer } from '~/types/order'
import { apiError } from '~/utils/api-error'
import {
  isActiveOrder,
} from '~/utils/order'
import {
  deliveryProvider,
  deliveryStatus,
  deliveryCost,
  orderDeliveryMessage,
} from '~/utils/delivery'
import { knownMoney, money } from '~/utils/money'
import { lineAmount } from '~/utils/assembly'
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
const api = useApiClient()
const scheduleOpen = ref(false)
const scheduleBusy = ref(false)
const scheduleError = ref('')
const scheduleOptions = ref<QueueOffer | null>(null)
const selectedSlot = ref('')
const slotLabel = (value: string) => new Date(value).toLocaleString('ru-RU', {
  timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
})
async function openSchedule() {
  scheduleOpen.value = !scheduleOpen.value
  if (!scheduleOpen.value) return
  try {
    scheduleOptions.value = await api<QueueOffer>(`/orders/${id}/queue`)
  } catch (cause) { scheduleError.value = apiError(cause) }
}
async function updateSchedule(mode: 'ASAP' | 'SCHEDULED') {
  scheduleBusy.value = true
  scheduleError.value = ''
  try {
    await api(`/orders/${id}/fulfillment`, { method: 'PATCH', body: {
      fulfillmentMode: mode, scheduledFor: mode === 'SCHEDULED' ? selectedSlot.value : undefined,
    } })
    scheduleOpen.value = false
    await refreshOrder()
  } catch (cause) {
    scheduleError.value = apiError(cause)
    try { scheduleOptions.value = await api<QueueOffer>(`/orders/${id}/queue`) } catch { /* Keep the saved error visible. */ }
  } finally { scheduleBusy.value = false }
}
function saveSchedule() { void updateSchedule('SCHEDULED') }
function saveAsap() { void updateSchedule('ASAP') }

const active = computed(
  () => isActiveOrder(order.value.status),
)
const customerSections = computed(() => [
  { hash: '#order-items', label: 'Состав' },
  { hash: '#order-receiving', label: 'Получение' },
  { hash: '#order-summary', label: 'Итог' },
  ...(order.value.assemblyFinalizedAt && order.value.payment &&
    order.value.status !== 'CANCELED' && order.value.payment.status !== 'CANCELED'
    ? [{ hash: '#order-payment', label: 'Оплата' }] : []),
  ...(order.value.issues.length ? [{ hash: '#order-issues', label: 'Вопросы' }] : []),
  { hash: '#order-chat', label: 'Чат' },
])


const address = computed(() => formatAddress(order.value))

const replacementIds = computed(() => new Set(order.value.issues.map(issue => issue.replacementItemId).filter(id => id !== null)))
const issueByItem = computed(() => new Map(order.value.issues.map(issue => [issue.orderItemId, issue])))
function proposal(itemId: number) {
  const issue = issueByItem.value.get(itemId)
  if (issue?.type !== 'REPLACEMENT' ||
    (issue.status !== 'WAITING_CUSTOMER' && issue.resolution !== 'ACCEPT_REPLACEMENT') ||
    !issue.proposedName || !issue.proposedQty || !issue.proposedUnit) return ''
  return (issue.resolution === 'ACCEPT_REPLACEMENT' ? '✅ Замена принята: ' : 'Предложена замена: ') +
    issue.proposedName + ' · ' + qtyText(issue.proposedUnit, issue.proposedQty) +
    (issue.proposedPrice && issue.proposedPriceQty
      ? ' · ' + money(lineAmount(issue.proposedPrice, issue.proposedQty, issue.proposedPriceQty)) : '')
}

let timer: ReturnType<typeof setInterval> | undefined
let refreshing = false
async function refreshOrder() {
  if (refreshing) return
  refreshing = true
  try { await refresh() } finally { refreshing = false }
}
function visible() {
  if (document.visibilityState === 'visible' && data.value && active.value) void refreshOrder()
}
onMounted(() => {
  if (signIn) loginOpen.value = true
  document.addEventListener('visibilitychange', visible)
  timer = setInterval(visible, 5000)
})
onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', visible)
  if (timer) clearInterval(timer)
})

useSeoMeta({
  title: () =>
    `Заказ №${order.value?.id ?? ""}`,
})
</script>

<style scoped>
.order-queue {
  display: grid;
  justify-items: start;
  gap: 0.4rem;
  padding: 0.85rem 1rem;
  border: 1px solid color-mix(in srgb, var(--ui-primary) 40%, var(--ui-border));
  border-radius: 0.8rem;
  background: color-mix(in srgb, var(--ui-primary) 6%, var(--ui-bg));
}
.order-queue__edit { display: grid; gap: 0.5rem; width: min(100%, 25rem); }
.order-queue__select { width: 100%; min-height: var(--touch-target); padding: 0.5rem; border: 1px solid var(--ui-border); border-radius: 0.5rem; background: var(--ui-bg); }
.order-queue__actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.order {
  max-width: 60rem;
  min-width: 0;
  padding-block: 0.75rem var(--page-end);
}

.order__sign-in {
  display: grid;
  justify-items: start;
  gap: 1rem;
  margin-top: var(--card-padding);
}

.order__head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 0.5rem;
  margin-top: 0.5rem;
}

.order__title {
  font-size: clamp(1.25rem, 1rem + 1vw, var(--page-title));
  font-weight: 700;
  line-height: 1.1;
  overflow-wrap: anywhere;
}
.order__quick { color: var(--ui-text-muted); font-size: 0.8125rem; }
.order__headline { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; }
.order__headline strong { white-space: nowrap; }
.order__note { margin-top: 0.5rem; color: var(--ui-text-muted); font-size: 0.875rem; line-height: 1.45; }


.order__layout {
  display: grid;
  min-width: 0;
  gap: 0.75rem;
}

.card {
  min-width: 0;
  padding: 0.75rem;
  border: 1px solid var(--ui-border);
  border-radius: 1rem;
  scroll-margin-top: calc(var(--header-height) + 4.5rem);
}

.card--delivery {
  min-width: 0;
}

.card__title {
  margin-bottom: 0.65rem;
  font-size: 1.125rem;
  font-weight: 700;
}

.card__muted,
.item__qty {
  color: var(--ui-text-muted);
}
.item__price-change { color: var(--ui-warning); font-size: 0.875rem; font-weight: 600; }

.card__muted {
  margin-top: 0.35rem;
  overflow-wrap: anywhere;
}

.delivery {
  display: grid;
  grid-template-columns: repeat(
    auto-fit,
    minmax(min(100%, 10rem), 1fr)
  );
  gap: 0.65rem;
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
  margin-top: 0.75rem;
  justify-content: center;
}

.item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  justify-content: space-between;
  gap: 0.5rem;
  padding-block: 0.55rem;
}

.item > * {
  min-width: 0;
  overflow-wrap: anywhere;
}

.item__qty,
.item__state {
  margin-top: 0.15rem;
  font-size: 0.8125rem;
}

.card__summary {
  display: grid;
  gap: 0.5rem;
  margin-top: 0.75rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--ui-border);
  scroll-margin-top: calc(var(--header-height) + 4.5rem);
}

.card__summary > div {
  display: grid;
  gap: 0.25rem;
}

.card__summary strong {
  overflow-wrap: anywhere;
}

.card__total {
  padding-top: 0.5rem;
  border-top: 1px solid var(--ui-border);
  font-size: 1.125rem;
}

.order__refresh {
  margin-top: 0.75rem;
  color: var(--ui-text-muted);
  font-size: 0.875rem;
}

@media (min-width: 40rem) {
  .order { padding-top: var(--page-start); }
  .order__head {
    gap: 1rem;
  }
  .order__title { font-size: var(--page-title); }
  .order__layout { gap: 1rem; }
  .order__note { margin-top: 1rem; }
  .card { padding: var(--card-padding); }
  .card__title { margin-bottom: 1.25rem; font-size: var(--section-title); }
  .item { display: flex; gap: 1rem; padding-block: 0.75rem; }
  .item__qty, .item__state { font-size: 0.875rem; }
  .card__summary { gap: 0.75rem; margin-top: 1rem; padding-top: 1rem; }
  .card__total { padding-top: 0.75rem; font-size: 1.25rem; }

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
