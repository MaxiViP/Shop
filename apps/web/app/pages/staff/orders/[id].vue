<template>
  <UContainer v-if="order" class="workspace">
    <header class="workspace__bar">
      <div class="workspace__identity">
        <div class="workspace__heading">
          <AppBackButton fallback="/staff/orders" label="К заказам" />
          <h1 class="workspace__title">Заказ №{{ order.id }}</h1>
        </div>

        <div class="workspace__badges">
          <OrderStatus :status="order.status" :type="order.type" />
          <UBadge color="neutral" variant="soft">
            {{ order.type === 'DELIVERY' ? 'Доставка' : 'Самовывоз' }}
          </UBadge>
          <UBadge v-if="order.deliveryAt" color="info" variant="soft">
            {{ order.type === 'PICKUP' ? `${pickupTime(order.deliveryAt)} (МСК)` : date(order.deliveryAt) }}
          </UBadge>
          <UBadge v-if="order.scheduledFor" color="info" variant="soft">Предзаказ · подготовить к {{ pickupTime(order.scheduledFor) }} (МСК)</UBadge>
          <UBadge
            v-if="order.status === 'ASSEMBLING'"
            :color="pending ? 'warning' : 'success'"
            variant="soft"
          >
            Осталось позиций: {{ pending }}
          </UBadge>
          <span class="workspace__total">
            {{ order.finalSubtotal === null ? 'Предварительно' : 'Итого' }}:
            <strong>{{ knownMoney(order.finalTotal ?? order.total, 'Не рассчитано') }}</strong>
          </span>
        </div>
      </div>

      <div class="workspace__actions">
        <UButton
          v-if="order.status === 'NEW'"
          size="lg"
          :loading="actionLoading === 'confirm'"
          :disabled="Boolean(actionLoading)"
          @click="confirmOrder"
        >
          Подтвердить
        </UButton>

        <UButton
          v-if="order.status === 'CONFIRMED'"
          size="lg"
          :loading="actionLoading === 'assembly'"
          :disabled="Boolean(actionLoading) || (order.fulfillmentMode === 'SCHEDULED' && !scheduledDue)"
          @click="runAction('assembly', 'assembly/start', 'Сборка начата')"
        >
          Начать сборку
        </UButton>

        <UButton
          v-if="order.status === 'ASSEMBLING'"
          size="lg"
          :disabled="pending > 0 || toleranceBlocked || Boolean(actionLoading) || itemLoading !== null || priceBusy"
          :loading="actionLoading === 'finish'"
          @click="finishAssembly"
        >
          Завершить сборку
        </UButton>

        <UButton
          v-if="order.status === 'READY' && order.type === 'PICKUP' && order.payment?.status === 'PAID'"
          size="lg"
          :loading="actionLoading === 'pickup'"
          :disabled="Boolean(actionLoading)"
          @click="
            runAction('pickup', 'pickup/complete', 'Заказ выдан покупателю')
          "
        >
          Выдать покупателю
        </UButton>

        <UButton
          v-if="
            order.status === 'READY' &&
            order.type === 'DELIVERY' &&
            !order.delivery
          "
          type="button"
          size="lg"
          @click="goToDelivery"
        >
          Оформить доставку
        </UButton>

        <UButton
          v-if="canHandoff"
          size="lg"
          :loading="actionLoading === 'handoff'"
          :disabled="Boolean(actionLoading)"
          @click="handoff"
        >
          Передать заказ курьеру
        </UButton>

        <UButton
          v-if="
            order.status === 'DELIVERING' &&
            order.delivery?.provider === 'OTHER'
          "
          size="lg"
          :loading="actionLoading === 'delivered'"
          :disabled="Boolean(actionLoading)"
          @click="completeDelivery"
        >
          Доставлен
        </UButton>

        <UButton
          v-if="canSyncYandex"
          size="lg"
          variant="soft"
          :loading="actionLoading === 'yandex-sync'"
          :disabled="Boolean(actionLoading)"
          @click="syncYandex"
        >
          Обновить статус
        </UButton>

        <OrderCancellation :order="order" :disabled="Boolean(actionLoading)" @refresh="refresh" />
      </div>
    </header>

    <OrderSections :links="sections" :initial-hash="activeHash" />

    <section
      id="order-data"
      class="stage"
      :class="{ 'stage--active': selectedHash === '#order-data' }"
    >
      <header class="stage__head">
        <p class="stage__number">Этап 1</p>
        <h2 class="stage__title">Данные заказа</h2>
      </header>

      <div class="customer">
        <div>
          <span class="customer__label">Покупатель</span>
          <strong>{{ order.customerName }}</strong>
        </div>

        <div>
          <span class="customer__label">Телефон</span>
          <a :href="`tel:${order.customerPhone}`">
            <strong>{{ order.customerPhone }}</strong>
          </a>
        </div>

        <div v-if="order.type === 'DELIVERY' && address">
          <span class="customer__label">Адрес</span>
          <strong>{{ address }}</strong>
        </div>

        <div v-if="order.comment">
          <span class="customer__label">Комментарий</span>
          <strong>{{ order.comment }}</strong>
        </div>

        <div v-if="order.type === 'DELIVERY' && order.deliveryAt">
          <span class="customer__label">Желаемое время</span>
          <strong>{{ date(order.deliveryAt) }}</strong>
        </div>
      </div>
    </section>

    <section v-if="order.type === 'PICKUP'" class="stage">
      <h2 class="stage__title">Самовывоз</h2>
      <p>{{ order.scheduledFor ? `Подготовить к ${pickupTime(order.scheduledFor)} (МСК)` : 'Собирать сразу' }}</p>
    </section>

    <section
      id="assembly"
      class="stage"
      :class="{ 'stage--active': selectedHash === '#assembly' }"
    >
      <header class="stage__head">
        <p class="stage__number">Этап 2</p>
        <h2 class="stage__title">Сборка</h2>
      </header>

      <UAlert
        v-if="order.status === 'ASSEMBLING' && pending"
        class="workspace__alert"
        color="warning"
        variant="soft"
        :title="`Осталось обработать: ${pending}`"
        description="Отметьте каждую позицию как собранную или отсутствующую."
      />
      <UAlert v-if="toleranceBlocked" color="warning" title="Требуется подтверждение покупателя" description="Нельзя завершить сборку: есть позиции, требующие подтверждения покупателя." />

      <div class="items">
        <article v-for="item in order.items" :key="item.id" class="item">
          <div class="item__head">
            <div>
              <h3 class="item__name">{{ item.productName }}</h3>
              <p class="item__price">{{ itemPrice(item) }}</p>
              <p v-if="item.actualPrice !== null && item.actualPrice !== item.price" class="item__changed">Цена изменена: {{ money(item.price) }} → {{ money(item.actualPrice) }}</p>
            </div>
            <div class="item__state">
              <UBadge :color="itemColor(item.status)" variant="soft">
                {{ itemStatus(item.status) }}
              </UBadge>
              <button
                type="button"
                class="item__toggle"
                :aria-controls="`item-${item.id}-details`"
                :aria-expanded="openItemId === item.id"
                :aria-label="`${openItemId === item.id ? 'Скрыть' : 'Показать'} действия и детали: ${item.productName}`"
                @click="toggleItem(item.id)"
              ><UIcon name="i-lucide-chevron-down" :class="{ 'item__chevron--open': openItemId === item.id }" /></button>
            </div>
          </div>

          <dl class="item__glance">
            <div>
              <dt>Заказано</dt>
              <dd>{{ qtyText(item.unit, item.qty) }}</dd>
            </div>
            <div>
              <dt>Предварительно</dt>
              <dd>{{ money(item.total) }}</dd>
            </div>
            <div v-if="item.actualQty !== null">
              <dt>Факт</dt>
              <dd>{{ qtyText(item.unit, item.actualQty) }}</dd>
            </div>
          </dl>

          <div :id="`item-${item.id}-details`" class="item__details" :class="{ 'item__details--open': openItemId === item.id }">
            <p v-if="item.actualTotal !== null" class="item__actual-total">
              Фактическая стоимость: <strong>{{ money(item.actualTotal) }}</strong>
            </p>
            <div v-if="order.status === 'ASSEMBLING' && item.status === 'PENDING'" class="item__actions">
              <UFormField :label="item.unit === 'GRAM' ? 'Фактический вес, г' : 'Фактическое количество'" class="item__quantity">
                <UInput v-model.number="actual[item.id]" class="item__input" type="number" inputmode="numeric" min="1" step="1" size="lg" />
              </UFormField>
              <UButton :loading="itemLoading === item.id" :disabled="itemLoading !== null" @click="pick(item.id)">
                Собрано
              </UButton>
              <UButton color="error" variant="soft" :loading="itemLoading === item.id" :disabled="itemLoading !== null" @click="missing(item.id)">Нет в наличии</UButton>
              <UButton class="item__reset" variant="ghost" color="neutral" :disabled="itemLoading !== null" @click="drafts.reset(item.id)">Сбросить</UButton>
            </div>
            <div v-else-if="order.status === 'ASSEMBLING'" class="item__actions">
              <UButton type="button" color="neutral" variant="soft" :loading="itemLoading === item.id" :disabled="itemLoading !== null" @click="returnToAssembly(item.id)">Вернуть в сборку</UButton>
            </div>
            <OrderWeight v-if="item.unit === 'GRAM' && item.status !== 'MISSING'" :requested="item.qty" :actual="actual[item.id] ?? item.qty" :price="item.actualPrice ?? item.price" :price-qty="item.priceQty" :bps="order.weightToleranceBps" :approved="approvedWeight(order.issues?.find(issue => issue.orderItemId === item.id), item.actualQty)" />
            <OrderItemPrice :order-id="id" :item="item" :editable="canChangePrice(item)" :disabled="itemLoading !== null || Boolean(actionLoading)" @busy="priceBusy = $event" @refresh="refresh" />
          </div>
        </article>
      </div>
      <OrderExtras :extras="order.extras ?? []" staff :order-id="id" :editable="order.status === 'ASSEMBLING' && !order.assemblyFinalizedAt" @refresh="refresh" />
    </section>
    <section
      id="order-summary"
      class="stage"
      :class="{ 'stage--active': selectedHash === '#order-summary' }"
    >
      <header class="stage__head">
        <p class="stage__number">Этап 3</p>
        <h2 class="stage__title">Итог заказа</h2>
      </header>

      <div class="summary">
        <div class="summary__row">
          <span>Предварительная стоимость товаров</span>
          <strong>{{ money(order.subtotal) }}</strong>
        </div>

        <div v-if="order.finalSubtotal !== null" class="summary__row">
          <span>Товары и услуги</span>
          <strong>{{ money(order.finalSubtotal) }}</strong>
        </div>

        <div class="summary__row">
          <span>
            {{
              order.type === 'PICKUP' ? 'Самовывоз' : order.delivery?.provider === 'YANDEX'
                ? 'Доставка Яндекс'
                : 'Доставка'
            }}
          </span>
          <strong>{{ knownMoney(order.deliveryPrice, 'Не рассчитана') }}</strong>
        </div>

        <div
          class="summary__row summary__row--total"
        >
          <span>{{ order.finalSubtotal === null ? 'Предварительный итог' : 'Фактический итог' }}</span>
          <strong>{{ knownMoney(order.finalTotal ?? order.total, 'Не рассчитано') }}</strong>
        </div>
      </div>
      <UAlert v-if="order.status === 'READY' && order.type === 'DELIVERY' && order.payment?.status !== 'PAID'" color="info" title="Проверьте поступление оплаты" description="Кнопка «Оплата получена — оформить доставку» подтвердит получение денег и запустит оформление доставки." />
      <OrderStaffPayment :order-id="id" :type="order.type" :payment="order.payment" @refresh="refresh" />
      <UButton v-if="canReopen" variant="outline" :disabled="Boolean(actionLoading)" @click="runAction('reopen', 'assembly/reopen', 'Заказ возвращён к сборке')">Вернуть к сборке</UButton>
    </section>

    <OrderCoordination :key="order.id" :base="`/staff/orders/${id}`" :bps="order.weightToleranceBps" staff :phone="order.customerPhone" :assembling="order.status === 'ASSEMBLING'" :has-issues="order.issues.length > 0" @refresh="refresh" />

    <section
      v-if="showDelivery"
      id="delivery"
      class="delivery stage"
      :class="{ 'stage--active': selectedHash === '#delivery' }"
    >
      <header class="delivery__head">
        <div>
          <p class="delivery__label">Этап 4 · Внешняя служба</p>
          <h2 class="delivery__title">Доставка</h2>
          <p class="delivery__description">
            {{ deliveryHint }}
          </p>
        </div>

        <UBadge v-if="order.delivery" color="info" variant="soft">
          {{ deliveryStatus[order.delivery.status] }}
        </UBadge>
      </header>

      <div class="copy-card">
        <h3 class="copy-card__title">Данные для вызова курьера</h3>

        <div class="copy-card__actions">
          <UButton
            variant="soft"
            color="neutral"
            @click="copy(address, 'Адрес скопирован')"
          >
            Скопировать адрес
          </UButton>
          <UButton
            variant="soft"
            color="neutral"
            @click="copy(order.customerPhone, 'Телефон скопирован')"
          >
            Скопировать телефон
          </UButton>
          <UButton
            variant="soft"
            color="neutral"
            :disabled="!order.comment"
            @click="copy(order.comment ?? '', 'Комментарий скопирован')"
          >
            Скопировать комментарий
          </UButton>
          <UButton @click="copy(courierText, 'Данные заказа скопированы')">
            Скопировать всё
          </UButton>
        </div>
      </div>

      <div v-if="order.delivery" class="delivery-card">
        <dl class="delivery-card__details">
          <div>
            <dt>Сервис</dt>
            <dd>{{ deliveryProvider[order.delivery.provider] }}</dd>
          </div>
          <div>
            <dt>Статус</dt>
            <dd>{{ deliveryStatus[order.delivery.status] }}</dd>
          </div>
          <div v-if="order.delivery.externalOrderId">
            <dt>Внешний ID</dt>
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
          <div>
            <dt>Стоимость доставки</dt>
            <dd>{{ knownMoney(order.delivery.price, 'Не указана') }}</dd>
          </div>
        </dl>

        <div class="delivery-card__actions">
          <UButton
            v-if="order.delivery.trackingUrl"
            :to="order.delivery.trackingUrl"
            target="_blank"
            rel="noopener noreferrer"
            variant="soft"
          >
            Открыть отслеживание
          </UButton>
          <UButton
            variant="soft"
            color="neutral"
            @click="copy(trackingPageUrl, 'Ссылка покупателю скопирована')"
          >
            Скопировать tracking-ссылку
          </UButton>
          <UButton
            variant="soft"
            color="neutral"
            @click="copy(smsText, 'SMS-текст скопирован')"
          >
            Скопировать SMS-текст
          </UButton>
        </div>
      </div>

      <form
        v-if="order.status === 'READY' && order.assemblyFinalizedAt && order.payment && ['AWAITING', 'REPORTED', 'PAID'].includes(order.payment.status)"
        class="delivery-form"
        @submit.prevent="saveDelivery"
      >
        <div>
          <h3 class="delivery-form__title">Внешняя доставка</h3>
          <p class="delivery-form__description">
            Выберите автоматическую Яндекс Доставку или оформите другую
            службу вручную.
          </p>
        </div>

        <div class="delivery-form__grid delivery-form__grid--provider">
          <UFormField label="Сервис" required>
            <USelect
              v-model="form.provider"
              :items="providerOptions"
              :disabled="Boolean(order.delivery?.externalOrderId)"
              size="lg"
            />
          </UFormField>
        </div>

        <div v-if="form.provider === 'YANDEX'" class="yandex-delivery">
          <UAlert v-if="order.payment?.status !== 'PAID'" color="info" title="Вызвать Яндекс можно после подтверждения оплаты товаров" />
          <UAlert
            v-if="!yandexConfig?.yandexEnabled"
            color="warning"
            title="Автоматическая Яндекс Доставка не настроена"
            description="Проверьте YANDEX_DELIVERY_TOKEN и данные точки отправления. Другая служба доставки продолжает работать."
          />

          <template v-else-if="!order.delivery?.externalOrderId">
            <div v-if="yandexQuote" class="yandex-delivery__quote">
              <div>
                <span>Стоимость доставки</span>
                <strong>{{ money(yandexQuote.price) }}</strong>
              </div>
              <div>
                <span>Курьер ориентировочно</span>
                <strong>{{ yandexEta }}</strong>
              </div>
              <p v-if="yandexQuote.expiresAt" class="yandex-delivery__expires">
                Предложение действительно до {{ date(yandexQuote.expiresAt) }}
              </p>
            </div>

            <div class="delivery-form__actions">
              <UButton
                type="button"
                size="lg"
                variant="soft"
                :loading="actionLoading === 'yandex-quote'"
                :disabled="Boolean(actionLoading)"
                @click="calculateYandex"
              >
                {{
                  yandexQuote
                    ? 'Пересчитать Яндекс Доставку'
                    : 'Рассчитать Яндекс Доставку'
                }}
              </UButton>
              <UButton
                v-if="yandexQuote"
                type="button"
                size="lg"
                :loading="actionLoading === 'yandex-order'"
                :disabled="Boolean(actionLoading)"
                @click="orderYandex"
              >
                {{ order.payment?.status === 'PAID' ? 'Повторить оформление доставки' : 'Оплата получена — оформить доставку' }} — {{ money(yandexQuote.price) }}
              </UButton>
            </div>
          </template>

          <div v-else class="delivery-form__actions">
            <UButton
              type="button"
              size="lg"
              variant="soft"
              :loading="actionLoading === 'yandex-sync'"
              :disabled="Boolean(actionLoading)"
              @click="syncYandex"
            >
              Обновить статус Яндекс Доставки
            </UButton>
          </div>
        </div>

        <template v-else>
          <div class="delivery-form__grid">
            <UFormField label="Ссылка на отслеживание (необязательно)">
              <UInput
                v-model="form.trackingUrl"
                type="url"
                placeholder="https://... или http://..."
                size="lg"
              />
            </UFormField>

            <UFormField label="Номер доставки (необязательно)">
              <UInput v-model="form.externalOrderId" size="lg" />
            </UFormField>

            <UFormField label="Имя курьера *" required>
              <AppTextInput v-model="form.courierName" required size="lg" />
            </UFormField>

            <UFormField label="Телефон курьера *" required>
              <AppTextInput
                v-model="form.courierPhone"
                format="phone"
                type="tel"
                required
                placeholder="+7 999 123-45-67"
                size="lg"
              />
            </UFormField>

            <UFormField label="Стоимость доставки, ₽" required>
              <UInput
                v-model="form.priceRubles"
                inputmode="decimal"
                placeholder="450"
                required
                size="lg"
              />
            </UFormField>
          </div>

          <div class="delivery-form__actions">
            <UButton
              type="submit"
              size="lg"
              :loading="deliveryLoading"
              :disabled="deliveryLoading || Boolean(actionLoading)"
            >
              {{ order.payment?.status === 'PAID' ? 'Сохранить доставку' : 'Оплата получена — оформить доставку' }}
            </UButton>

            <UButton
              v-if="canHandoff"
              type="button"
              size="lg"
              :loading="actionLoading === 'handoff'"
              :disabled="deliveryLoading || Boolean(actionLoading)"
              @click="handoff"
            >
              Передать заказ курьеру
            </UButton>
          </div>
        </template>
      </form>
    </section>
  </UContainer>
</template>

<script setup lang="ts">
import { formatAddress } from "~/utils/address";
import type {
  DeliveryProvider,
  OrderItemStatus,
  StaffOrderDetail,
  YandexQuote,
} from '~/types/order'
import { useAuthStore } from '~/stores/auth'
import { apiError } from '~/utils/api-error'
import { deliveryProvider, deliveryStatus } from '~/utils/delivery'
import { knownMoney, kopecksToRubles, money, rublesToKopecks } from '~/utils/money'
import { qtyText } from '~/utils/qty'
import { pickupTime } from '~/utils/pickup'
import { focusedAssemblyItem } from '~/utils/assembly'

interface DeliveryForm {
  provider: DeliveryProvider
  trackingUrl: string
  externalOrderId: string
  courierName: string
  courierPhone: string
  priceRubles: string
}

interface YandexConfig {
  yandexEnabled: boolean
}

const route = useRoute()
const requestUrl = useRequestURL()
const config = useRuntimeConfig()
const auth = useAuthStore()
const api = useApiClient()
const toast = useToast()
const newOrdersRevision = useNewOrdersRevision()

if (auth.user?.role !== 'SELLER' && auth.user?.role !== 'ADMIN') {
  await navigateTo('/')
}

const id = Number(route.params.id)

const { data, error, refresh } = await useApi<StaffOrderDetail>(
  `/staff/orders/${id}`,
)
const { data: yandexConfig } = await useApi<YandexConfig>(
  '/staff/orders/delivery/yandex/config',
)

if (error.value || !data.value) {
  throw createError({
    statusCode: 404,
    statusMessage: 'Заказ не найден',
  })
}

const order = computed(() => data.value!)
const clock = ref(Date.now())
let dueTimer: ReturnType<typeof setInterval> | undefined
onMounted(() => { dueTimer = setInterval(() => { clock.value = Date.now() }, 30_000) })
onBeforeUnmount(() => { if (dueTimer) clearInterval(dueTimer) })
const scheduledDue = computed(() => !order.value.scheduledFor ||
  Date.parse(order.value.scheduledFor) - order.value.preparationMinutes * 60_000 <= clock.value)
const drafts = assemblyDrafts()
const actual = drafts.values
const itemLoading = ref<number | null>(null)
const priceBusy = ref(false)
const expandedItem = ref<number | 'none' | null>(null)
const actionLoading = ref<string | null>(null)
const deliveryLoading = ref(false)
const yandexQuote = ref<YandexQuote | null>(null)

const form = reactive<DeliveryForm>({
  provider: 'YANDEX',
  trackingUrl: '',
  externalOrderId: '',
  courierName: '',
  courierPhone: '',
  priceRubles: '',
})

const providerOptions = [
  { label: deliveryProvider.YANDEX, value: 'YANDEX' },
  { label: deliveryProvider.OTHER, value: 'OTHER' },
]

watch(
  () => order.value.items,
  (items) => {
    drafts.sync(items)
  },
  { immediate: true },
)

watch(
  () => order.value.delivery,
  (delivery) => {
    if (!delivery) return

    form.provider = delivery.provider
    form.trackingUrl = delivery.trackingUrl ?? ''
    form.externalOrderId = delivery.externalOrderId ?? ''
    form.courierName = delivery.courierName ?? ''
    form.courierPhone = delivery.courierPhone ?? ''
    form.priceRubles =
      delivery.price === null ? '' : kopecksToRubles(delivery.price)
  },
  { immediate: true },
)

const pending = computed(
  () => order.value.items.filter((item) => item.status === 'PENDING').length,
)
const openItemId = computed(() => focusedAssemblyItem(
  order.value.items, order.value.status === 'ASSEMBLING', expandedItem.value,
))
function toggleItem(itemId: number) {
  expandedItem.value = openItemId.value === itemId ? 'none' : itemId
}

const toleranceBlocked = computed(() => order.value.status === 'ASSEMBLING' && (order.value.issues?.some(issue => ['WAITING_CUSTOMER', 'WAITING_SELLER'].includes(issue.status)) || order.value.items.some(item => {
  if (item.unit !== 'GRAM' || item.status === 'MISSING') return false
  const qty = item.status === 'PENDING' ? actual[item.id] : item.actualQty
  if (item.status === 'PICKED' && approvedWeight(order.value.issues?.find(issue => issue.orderItemId === item.id), item.actualQty)) return false
  if (typeof qty !== 'number' || !Number.isSafeInteger(qty) || qty <= 0) return false
  try {
    return outsideTolerance(item.unit, item.qty, qty, order.value.weightToleranceBps)
  } catch {
    return true
  }
})))
const canReopen = computed(() => order.value.status === 'READY' && (!order.value.payment || order.value.payment.status === 'AWAITING') && !order.value.delivery?.externalOrderId && order.value.delivery?.provider !== 'OTHER')

const canHandoff = computed(
  () =>
    order.value.payment?.status === 'PAID' &&
    order.value.status === 'READY' &&
    order.value.type === 'DELIVERY' &&
    order.value.delivery?.provider === 'OTHER' &&
    order.value.delivery?.status === 'ASSIGNED' &&
    order.value.delivery.price !== null && order.value.delivery.price > 0,
)

const canSyncYandex = computed(
  () =>
    order.value.delivery?.provider === 'YANDEX' &&
    Boolean(order.value.delivery.externalOrderId) &&
    ['READY', 'DELIVERING'].includes(order.value.status),
)

const showDelivery = computed(
  () =>
    order.value.type === 'DELIVERY' &&
    (order.value.delivery !== null ||
      ['READY', 'DELIVERING', 'COMPLETED', 'CANCELED'].includes(
        order.value.status,
      )),
)

const sections = computed(() => [
  { hash: '#order-data', label: 'Данные' },
  { hash: '#assembly', label: 'Сборка' },
  { hash: '#order-summary', label: 'Итог' },
  ...(order.value.issues.length ? [{ hash: '#order-issues', label: 'Вопросы' }] : []),
  { hash: '#order-chat', label: 'Чат' },
  ...(showDelivery.value ? [{ hash: '#delivery', label: 'Доставка' }] : []),
])

const activeHash = computed(() => {
  if (order.value.status === 'ASSEMBLING') return '#assembly'

  if (
    order.value.type === 'DELIVERY' &&
    ['READY', 'DELIVERING'].includes(order.value.status) &&
    order.value.payment?.status === 'PAID'
  ) {
    return '#delivery'
  }

  if (['NEW', 'CONFIRMED'].includes(order.value.status)) return '#order-data'

  return '#order-summary'
})
const selectedHash = computed(() => route.hash || activeHash.value)

const deliveryHint = computed(() =>
  form.provider === 'YANDEX'
    ? 'Стоимость и статусы Яндекс Доставки получает backend. Продавец только рассчитывает и заказывает доставку.'
    : 'Для другой службы укажите имя и телефон курьера. Ссылка необязательна.',
)

const yandexEta = computed(() => {
  if (!yandexQuote.value) return ''

  const from = new Date(yandexQuote.value.pickupFrom)
  const to = new Date(yandexQuote.value.deliveryTo)
  const minutes = Math.max(1, Math.round((to.getTime() - from.getTime()) / 60_000))
  return `до ${minutes} мин.`
})

const address = computed(() =>
  [
    formatAddress(order.value),
    order.value.entrance ? `подъезд ${order.value.entrance}` : null,
    order.value.floor ? `этаж ${order.value.floor}` : null,
    order.value.intercom ? `домофон ${order.value.intercom}` : null,
  ]
    .filter(Boolean)
    .join(', '),
)

const courierText = computed(() =>
  [
    `Получатель: ${order.value.customerName}`,
    `Телефон: ${order.value.customerPhone}`,
    order.value.city || order.value.street || order.value.house
      ? `Адрес: ${formatAddress(order.value, false)}`
      : null,
    order.value.flat ? `Квартира: ${order.value.flat}` : null,
    order.value.entrance ? `Подъезд: ${order.value.entrance}` : null,
    order.value.floor ? `Этаж: ${order.value.floor}` : null,
    order.value.intercom ? `Домофон: ${order.value.intercom}` : null,
    order.value.comment ? `Комментарий: ${order.value.comment}` : null,
    `Заказ №${order.value.id}`,
  ]
    .filter(Boolean)
    .join('\n'),
)

const trackingPageUrl = computed(() => {
  if (!order.value.delivery) return ''

  const base = config.public.siteUrl || requestUrl.origin

  return new URL(`/track/${order.value.delivery.publicToken}`, base).toString()
})

const smsText = computed(
  () =>
    `Заказ №${order.value.id} ${
      order.value.delivery?.status === 'PICKED_UP' ||
      order.value.delivery?.status === 'DELIVERED'
        ? 'передан курьеру'
        : 'готов к доставке'
    }. Следить за доставкой: ${trackingPageUrl.value}`,
)

async function runAction(name: string, path: string, success: string) {
  actionLoading.value = name

  try {
    await api(`/staff/orders/${id}/${path}`, {
      method: 'POST',
    })
    newOrdersRevision.value++
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
    actionLoading.value = null
  }
}

async function finishAssembly() {
  await runAction('finish', 'assembly/finish', 'Заказ собран')
}

async function confirmOrder() {
  if (await runAction('confirm', 'confirm', 'Заказ подтверждён')) await navigateTo('/staff/orders?tab=assembly')
}

async function goToDelivery() {
  try {
    await navigateTo({ path: route.path, hash: '#delivery' })
    await nextTick()
    document.getElementById('delivery')?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    })
  } catch (error) {
    toast.add({
      title: 'Не удалось открыть раздел доставки',
      description: apiError(error),
      color: 'error',
    })
  }
}

async function handoff() {
  await runAction('handoff', 'delivery/handoff', 'Заказ передан курьеру')
}

async function completeDelivery() {
  await runAction('delivered', 'delivery/complete', 'Доставка завершена')
}

async function calculateYandex() {
  actionLoading.value = 'yandex-quote'

  try {
    yandexQuote.value = await api<YandexQuote>(
      `/staff/orders/${id}/delivery/yandex/quote`,
      { method: 'POST' },
    )
    toast.add({ title: 'Стоимость Яндекс Доставки рассчитана' })
    await refresh()
  } catch (error) {
    toast.add({
      title: 'Не удалось рассчитать Яндекс Доставку',
      description: apiError(error),
      color: 'error',
    })
  } finally {
    actionLoading.value = null
  }
}

async function orderYandex() {
  if (order.value.payment?.status !== 'PAID' && !window.confirm('Подтвердите, что оплата действительно поступила. После подтверждения заказ будет отмечен как оплаченный и начнётся оформление доставки.')) return
  actionLoading.value = 'yandex-order'

  try {
    await api(`/staff/orders/${id}/delivery/yandex/confirm`, { method: 'POST' })
    yandexQuote.value = null
    await refresh()
    toast.add({
      title: 'Яндекс Доставка заказана',
      description: 'Фактическая стоимость и заявка сохранены.',
    })
  } catch (error) {
    toast.add({
      title: 'Не удалось заказать Яндекс Доставку',
      description: apiError(error),
      color: 'error',
    })
    await refresh()
  } finally {
    actionLoading.value = null
  }
}

async function syncYandex() {
  actionLoading.value = 'yandex-sync'

  try {
    await api(`/staff/orders/${id}/delivery/yandex/sync`, { method: 'POST' })
    await refresh()
    toast.add({ title: 'Статус Яндекс Доставки обновлён' })
  } catch (error) {
    toast.add({
      title: 'Не удалось обновить Яндекс Доставку',
      description: apiError(error),
      color: 'error',
    })
  } finally {
    actionLoading.value = null
  }
}

async function pick(itemId: number) {
  const actualQty = actual[itemId]

  if (
    typeof actualQty !== 'number' ||
    !Number.isInteger(actualQty) ||
    actualQty < 1
  ) {
    toast.add({
      title: 'Введите положительное целое количество или вес',
      color: 'error',
    })
    return
  }

  itemLoading.value = itemId

  try {
    await api(`/staff/orders/${id}/items/${itemId}`, {
      method: 'PATCH',
      body: {
        status: 'PICKED',
        actualQty,
      },
    })
    await refresh()
    drafts.reset(itemId)
    expandedItem.value = null
    toast.add({ title: 'Позиция собрана' })
  } catch (error) {
    toast.add({
      title: 'Не удалось сохранить позицию',
      description: apiError(error),
      color: 'error',
    })
  } finally {
    itemLoading.value = null
  }
}

async function missing(itemId: number) {
  itemLoading.value = itemId

  try {
    await api(`/staff/orders/${id}/items/${itemId}`, {
      method: 'PATCH',
      body: {
        status: 'MISSING',
      },
    })
    await refresh()
    drafts.reset(itemId)
    expandedItem.value = null
    toast.add({ title: 'Позиция отмечена отсутствующей' })
  } catch (error) {
    toast.add({
      title: 'Не удалось сохранить позицию',
      description: apiError(error),
      color: 'error',
    })
  } finally {
    itemLoading.value = null
  }
}

async function returnToAssembly(itemId: number) {
  itemLoading.value = itemId

  try {
    await api(`/staff/orders/${id}/items/${itemId}`, {
      method: 'PATCH',
      body: {
        status: 'PENDING',
      },
    })
    await refresh()
    drafts.reset(itemId)
    expandedItem.value = itemId
    toast.add({ title: 'Позиция возвращена в сборку' })
  } catch (error) {
    toast.add({
      title: 'Не удалось вернуть позицию в сборку',
      description: apiError(error),
      color: 'error',
    })
  } finally {
    itemLoading.value = null
  }
}

async function saveDelivery() {
  if (form.provider !== 'OTHER') {
    toast.add({
      title: 'Используйте автоматический расчёт Яндекс Доставки',
      color: 'error',
    })
    return
  }

  if (!form.courierName.trim() || !form.courierPhone.trim()) {
    toast.add({
      title: 'Укажите имя и телефон курьера',
      color: 'error',
    })
    return
  }

  const priceKopecks = rublesToKopecks(form.priceRubles)

  if (priceKopecks === null) {
    toast.add({
      title: 'Укажите положительную стоимость до 1 000 000 ₽, не более двух знаков после запятой',
      color: 'error',
    })
    return
  }

  deliveryLoading.value = true

  try {
    if (order.value.payment?.status !== 'PAID' && !window.confirm('Подтвердите, что оплата поступила. Заказ будет отмечен как оплаченный и оформлена доставка.')) return
    await api(`/staff/orders/${id}/delivery/confirm`, {
      method: 'POST',
      body: {
        provider: form.provider,
        trackingUrl: optional(form.trackingUrl),
        externalOrderId: optional(form.externalOrderId),
        courierName: optional(form.courierName),
        courierPhone: optional(form.courierPhone),
        price: priceKopecks,
      },
    })
    await refresh()
    toast.add({ title: 'Данные доставки сохранены' })
  } catch (error) {
    toast.add({
      title: 'Не удалось сохранить доставку',
      description: apiError(error),
      color: 'error',
    })
    await refresh()
  } finally {
    deliveryLoading.value = false
  }
}

async function copy(value: string, success: string) {
  try {
    await navigator.clipboard.writeText(value)
    toast.add({ title: success })
  } catch (error) {
    toast.add({
      title: 'Не удалось скопировать',
      description: apiError(error),
      color: 'error',
    })
  }
}

function optional(value: string) {
  const result = value.trim()
  return result || undefined
}

function itemPrice(item: StaffOrderDetail['items'][number]) {
  return `Цена заказа ${money(item.price)} / ${qtyText(item.unit, item.priceQty)}`
}

function canChangePrice(item: StaffOrderDetail['items'][number]) {
  return order.value.status === 'ASSEMBLING' && !order.value.assemblyFinalizedAt &&
    !['REPORTED', 'PAID'].includes(order.value.payment?.status ?? '') &&
    item.status !== 'MISSING' && !order.value.issues.some(issue =>
      issue.orderItemId === item.id && (issue.replacementItemId !== null ||
        (issue.status === 'RESOLVED' && issue.resolution === 'REMOVE_ITEM')));
}

function itemStatus(status: OrderItemStatus) {
  return {
    PENDING: 'Не собрано',
    PICKED: 'Собрано',
    MISSING: 'Нет в наличии',
  }[status]
}

function itemColor(status: OrderItemStatus) {
  const colors = {
    PENDING: 'neutral',
    PICKED: 'success',
    MISSING: 'error',
  } as const satisfies Record<OrderItemStatus, 'neutral' | 'success' | 'error'>

  return colors[status]
}

function date(value: string) {
  return new Date(value).toLocaleString('ru-RU', {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

useSeoMeta({
  title: () => `Заказ №${order.value.id}`,
})
</script>

<style scoped>
.workspace {
  max-width: 68.75rem;
  min-width: 0;
  padding-block: 0.5rem var(--page-end);
}

.workspace__bar {
  display: flex;
  min-width: 0;
  align-items: stretch;
  flex-direction: column;
  gap: 0.65rem;
  margin: 0.5rem 0 0.75rem;
  padding: 0.75rem;
  border: 1px solid var(--ui-border);
  border-radius: 1rem;
  background: color-mix(in srgb, var(--ui-bg) 94%, transparent);
  box-shadow: 0 12px 32px rgb(0 0 0 / 8%);
  backdrop-filter: blur(12px);
}

.workspace__identity {
  display: grid;
  min-width: 0;
  gap: 0.45rem;
}
.workspace__heading { display: flex; align-items: center; flex-wrap: wrap; gap: 0.35rem; }

.delivery__label {
  color: var(--ui-primary);
  font-weight: 600;
}

.workspace__title {
  font-size: clamp(1.25rem, 1.1rem + 1vw, 2rem);
  font-weight: 700;
  line-height: 1.15;
  overflow-wrap: anywhere;
}

.workspace__badges,
.workspace__actions,
.copy-card__actions,
.delivery-card__actions,
.delivery-form__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.workspace__badges {
  min-width: 0;
  align-items: center;
}

.workspace__total {
  display: inline-flex;
  gap: 0.3rem;
  align-items: baseline;
  color: var(--ui-text-muted);
  font-size: 0.875rem;
}
.workspace__total strong { color: var(--ui-text); }

.workspace__actions {
  justify-content: flex-start;
}

.workspace__actions > *,
.item__actions > *,
.copy-card__actions > *,
.delivery-card__actions > *,
.delivery-form__actions > * {
  width: auto;
  min-height: var(--touch-target);
  justify-content: center;
}

.workspace__alert {
  margin-top: 0.5rem;
}

.stage {
  display: grid;
  gap: 0.75rem;
  margin-top: 0.75rem;
  min-width: 0;
  padding: 0.5rem;
  scroll-margin-top: calc(var(--header-height) + 4.5rem);
  border: 2px solid transparent;
  border-radius: 1.25rem;
}

.stage.stage--active {
  border-color: var(--ui-primary);
  background: color-mix(in srgb, var(--ui-primary) 6%, var(--ui-bg));
  box-shadow: 0 14px 40px rgb(0 0 0 / 8%);
}

.stage__number {
  display: none;
  color: var(--ui-primary);
  font-size: 0.875rem;
  font-weight: 700;
  text-transform: uppercase;
}

.stage__title {
  font-size: 1.125rem;
  font-weight: 700;
}

.customer,
.summary,
.delivery,
.copy-card,
.delivery-card,
.delivery-form {
  border: 1px solid var(--ui-border);
  border-radius: 1rem;
  min-width: 0;
}

.customer {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 11.25rem), 1fr));
  gap: 0.65rem;
  padding: 0.75rem;
}

.customer > div,
.delivery-card__details > div {
  display: grid;
  align-content: start;
  gap: 0.25rem;
  min-width: 0;
}

.customer__label,
.delivery-card__details dt {
  color: var(--ui-text-muted);
  font-size: 0.875rem;
}

.items {
  display: grid;
  min-width: 0;
  gap: 0.5rem;
}

.item {
  display: grid;
  min-width: 0;
  gap: 0.45rem;
  padding: 0.75rem;
  border: 1px solid var(--ui-border);
  border-radius: 1rem;
}

.item__head {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 0.5rem;
}
.item__head > div:first-child { min-width: 0; }
.item__state { display: flex; flex: none; align-items: center; gap: 0.25rem; }
.item__toggle {
  display: grid;
  place-items: center;
  width: var(--touch-target);
  height: var(--touch-target);
  border: 1px solid var(--ui-border);
  border-radius: 0.5rem;
  color: var(--ui-text);
}
.item__toggle:focus-visible { outline: 2px solid var(--ui-primary); outline-offset: 2px; }
.item__chevron--open { transform: rotate(180deg); }

.item__glance {
  display: flex;
  flex-wrap: wrap;
  gap: 0.2rem 0.75rem;
  min-width: 0;
  font-size: 0.8125rem;
}
.item__glance > div { display: flex; gap: 0.25rem; min-width: 0; }
.item__glance dt { color: var(--ui-text-muted); }
.item__glance dd { font-weight: 600; overflow-wrap: anywhere; }
.item__details {
  display: none;
  gap: 0.5rem;
  padding-top: 0.5rem;
  border-top: 1px solid var(--ui-border);
}
.item__details--open { display: grid; }
.item__actual-total { font-size: 0.875rem; color: var(--ui-text-muted); }
.item__actual-total strong { color: var(--ui-text); }

.item__quantity { min-width: 0; grid-column: 1 / -1; }
.item__actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.5rem;
}
.item__actions > * { min-width: 0; }
.item__reset { grid-column: 1 / -1; justify-self: start; }
.item__actions :deep(button) { min-height: var(--touch-target); }
.item__input { min-width: 0; width: 100%; }
.item__input :deep(input) { min-height: var(--touch-target); }

.item__name {
  font-size: 1.0625rem;
  font-weight: 700;
  line-height: 1.3;
  overflow-wrap: anywhere;
}

.item__price {
  color: var(--ui-text-muted);
  font-size: 0.8125rem;
}
.item__changed { color: var(--ui-warning); font-size: 0.8125rem; font-weight: 600; }

.delivery-card__details,
.delivery-form__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 10rem), 1fr));
  gap: 1rem;
}

.delivery-card__details dd {
  font-weight: 600;
  overflow-wrap: anywhere;
}

.summary {
  display: grid;
  gap: 0.65rem;
  padding: 0.75rem;
}

.summary__row {
  display: grid;
  gap: 0.25rem;
}

.summary__row strong {
  overflow-wrap: anywhere;
}

.summary__row--total {
  padding-top: 0.65rem;
  border-top: 1px solid var(--ui-border);
  font-size: 1.25rem;
}

.delivery {
  display: grid;
  gap: 0.75rem;
  padding: 0.75rem;
}

.delivery__head {
  display: grid;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
}

.delivery__title {
  margin-top: 0.25rem;
  font-size: var(--section-title);
  font-weight: 700;
}

.delivery__description,
.delivery-form__description {
  margin-top: 0.5rem;
  color: var(--ui-text-muted);
  overflow-wrap: anywhere;
}

.copy-card,
.delivery-card,
.delivery-form,
.yandex-delivery {
  display: grid;
  gap: 1.25rem;
  padding: var(--card-padding);
  min-width: 0;
}

.copy-card__title,
.delivery-form__title {
  font-size: 1.125rem;
  font-weight: 700;
}

.delivery-form__grid--provider {
  width: 100%;
  max-width: 22.5rem;
}

.yandex-delivery {
  padding: 0;
}

.yandex-delivery__quote {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 11.25rem), 1fr));
  gap: 1rem;
  padding: 1.25rem;
  border: 2px solid var(--ui-primary);
  border-radius: 1rem;
  background: color-mix(in srgb, var(--ui-primary) 8%, var(--ui-bg));
}

.yandex-delivery__quote > div {
  display: grid;
  gap: 0.25rem;
}

.yandex-delivery__quote span,
.yandex-delivery__expires {
  color: var(--ui-text-muted);
}

.yandex-delivery__quote strong {
  font-size: 1.25rem;
}

.yandex-delivery__expires {
  grid-column: 1 / -1;
  font-size: 0.875rem;
}

.customer strong,
.customer a,
.delivery-card__details a {
  overflow-wrap: anywhere;
}

.workspace :deep(input),
.workspace :deep(textarea),
.workspace :deep(select) {
  min-width: 0;
  max-width: 100%;
  font-size: 1rem;
}

@media (min-width: 40rem) {
  .workspace { padding-top: var(--page-start); }
  .stage__number { display: block; }
  .stage__title { margin-top: 0.25rem; font-size: var(--section-title); }
  .item { gap: 1rem; padding: var(--card-padding); }
  .item__name { font-size: 1.25rem; }
  .item__toggle { display: none; }
  .item__details { display: grid; }
  .item__actions {
    display: flex;
    align-items: flex-end;
    flex-wrap: wrap;
  }
  .item__quantity { min-width: 12rem; grid-column: auto; }
  .item__reset { grid-column: auto; }

  .stage {
    padding: 1rem;
  }

  .summary__row {
    display: flex;
    justify-content: space-between;
    gap: 2rem;
  }
}

@media (min-width: 64rem) {
  .workspace__bar {
    position: sticky;
    z-index: 20;
    top: var(--header-height);
    align-items: center;
    justify-content: space-between;
    flex-direction: row;
    gap: 1.5rem;
    margin-inline: -1rem;
  }
  .workspace__actions { justify-content: flex-end; }

  .stage {
    scroll-margin-top: calc(var(--header-height) + 10rem);
  }
  .workspace :deep(#order-issues),
  .workspace :deep(#order-chat) {
    scroll-margin-top: calc(var(--header-height) + 10rem);
  }
}
</style>
