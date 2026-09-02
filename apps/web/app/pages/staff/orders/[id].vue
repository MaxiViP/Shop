<template>
  <UContainer v-if="order" class="workspace">
    <NuxtLink to="/staff/orders" class="workspace__back">
      ← К очереди заказов
    </NuxtLink>

    <header class="workspace__bar">
      <div class="workspace__identity">
        <div>
          <p class="workspace__number">Заказ №{{ order.id }}</p>
          <h1 class="workspace__title">
            {{ orderStatus[order.status].label }}
          </h1>
        </div>

        <div class="workspace__badges">
          <OrderStatus :status="order.status" />
          <UBadge color="neutral" variant="soft">
            {{ order.type === 'DELIVERY' ? 'Доставка' : 'Самовывоз' }}
          </UBadge>
          <UBadge v-if="order.deliveryAt" color="info" variant="soft">
            {{ date(order.deliveryAt) }}
          </UBadge>
          <UBadge
            v-if="order.status === 'ASSEMBLING'"
            :color="pending ? 'warning' : 'success'"
            variant="soft"
          >
            Осталось позиций: {{ pending }}
          </UBadge>
        </div>
      </div>

      <div class="workspace__actions">
        <UButton
          v-if="order.status === 'NEW'"
          size="lg"
          :loading="actionLoading === 'confirm'"
          :disabled="Boolean(actionLoading)"
          @click="runAction('confirm', 'confirm', 'Заказ подтверждён')"
        >
          Подтвердить
        </UButton>

        <UButton
          v-if="order.status === 'CONFIRMED'"
          size="lg"
          :loading="actionLoading === 'assembly'"
          :disabled="Boolean(actionLoading)"
          @click="runAction('assembly', 'assembly/start', 'Сборка начата')"
        >
          Начать сборку
        </UButton>

        <UButton
          v-if="order.status === 'ASSEMBLING'"
          size="lg"
          :disabled="pending > 0 || Boolean(actionLoading)"
          :loading="actionLoading === 'finish'"
          @click="finishAssembly"
        >
          Завершить сборку
        </UButton>

        <UButton
          v-if="order.status === 'READY' && order.type === 'PICKUP'"
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

        <UButton
          v-if="cancelable"
          size="lg"
          color="error"
          variant="soft"
          :loading="actionLoading === 'cancel'"
          :disabled="Boolean(actionLoading)"
          @click="runAction('cancel', 'cancel', 'Заказ отменён')"
        >
          Отменить
        </UButton>
      </div>
    </header>

    <nav class="stages" aria-label="Этапы работы с заказом">
      <NuxtLink
        v-for="stage in stages"
        :key="stage.id"
        :to="{ path: route.path, hash: stage.hash }"
        class="stages__link"
        :class="{ 'stages__link--active': activeStage === stage.id }"
        :aria-current="activeStage === stage.id ? 'step' : undefined"
      >
        <span class="stages__number">{{ stage.number }}</span>
        {{ stage.label }}
      </NuxtLink>
    </nav>

    <section
      id="order-data"
      class="stage"
      :class="{ 'stage--active': activeStage === 'details' }"
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

        <div v-if="address">
          <span class="customer__label">Адрес</span>
          <strong>{{ address }}</strong>
        </div>

        <div v-if="order.comment">
          <span class="customer__label">Комментарий</span>
          <strong>{{ order.comment }}</strong>
        </div>

        <div v-if="order.deliveryAt">
          <span class="customer__label">Желаемое время</span>
          <strong>{{ date(order.deliveryAt) }}</strong>
        </div>
      </div>
    </section>

    <section
      id="assembly"
      class="stage"
      :class="{ 'stage--active': activeStage === 'assembly' }"
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

      <div class="items">
        <article v-for="item in order.items" :key="item.id" class="item">
          <div class="item__head">
            <div>
              <h2 class="item__name">{{ item.productName }}</h2>
              <p class="item__price">{{ itemPrice(item) }}</p>
            </div>

            <UBadge :color="itemColor(item.status)" variant="soft">
              {{ itemStatus(item.status) }}
            </UBadge>
          </div>

          <dl class="item__stats">
            <div>
              <dt>
                {{ item.unit === 'GRAM' ? 'Заказанный вес' : 'Заказано' }}
              </dt>
              <dd>{{ quantity(item.qty, item.unit) }}</dd>
            </div>

            <div>
              <dt>Предварительная стоимость</dt>
              <dd>{{ money(item.total) }}</dd>
            </div>

            <div v-if="item.actualQty !== null">
              <dt>
                {{ item.unit === 'GRAM' ? 'Фактический вес' : 'Фактически' }}
              </dt>
              <dd>{{ quantity(item.actualQty, item.unit) }}</dd>
            </div>

            <div v-if="item.actualTotal !== null">
              <dt>Фактическая стоимость</dt>
              <dd>{{ money(item.actualTotal) }}</dd>
            </div>
          </dl>

          <div
            v-if="order.status === 'ASSEMBLING' && item.status === 'PENDING'"
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
                v-model.number="actual[item.id]"
                class="item__input"
                type="number"
                min="1"
                step="1"
                size="xl"
              />
            </UFormField>

            <UButton
              size="xl"
              :loading="itemLoading === item.id"
              :disabled="itemLoading !== null"
              @click="pick(item.id)"
            >
              Собрано
            </UButton>

            <UButton
              size="xl"
              color="error"
              variant="soft"
              :loading="itemLoading === item.id"
              :disabled="itemLoading !== null"
              @click="missing(item.id)"
            >
              Нет в наличии
            </UButton>
          </div>

          <div
            v-else-if="order.status === 'ASSEMBLING'"
            class="item__actions"
          >
            <UButton
              type="button"
              size="lg"
              color="neutral"
              variant="soft"
              :loading="itemLoading === item.id"
              :disabled="itemLoading !== null"
              @click="returnToAssembly(item.id)"
            >
              Вернуть в сборку
            </UButton>
          </div>
        </article>
      </div>
    </section>

    <section
      id="order-summary"
      class="stage"
      :class="{ 'stage--active': activeStage === 'summary' }"
    >
      <header class="stage__head">
        <p class="stage__number">Этап 3</p>
        <h2 class="stage__title">Итог заказа</h2>
      </header>

      <div class="summary">
        <div class="summary__row">
          <span>Предварительная стоимость</span>
          <strong>{{ money(order.total) }}</strong>
        </div>

        <div v-if="order.finalSubtotal !== null" class="summary__row">
          <span>Товары</span>
          <strong>{{ money(order.finalSubtotal) }}</strong>
        </div>

        <div v-if="order.deliveryPrice > 0" class="summary__row">
          <span>
            {{
              order.delivery?.provider === 'YANDEX'
                ? 'Доставка Яндекс'
                : 'Доставка'
            }}
          </span>
          <strong>{{ money(order.deliveryPrice) }}</strong>
        </div>

        <div
          v-if="order.finalTotal !== null"
          class="summary__row summary__row--total"
        >
          <span>Фактический итог</span>
          <strong>{{ money(order.finalTotal) }}</strong>
        </div>
      </div>
    </section>

    <section
      v-if="showDelivery"
      id="delivery"
      class="delivery stage"
      :class="{ 'stage--active': activeStage === 'delivery' }"
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
          <div v-if="order.delivery.price !== null">
            <dt>Стоимость курьера</dt>
            <dd>{{ money(order.delivery.price) }}</dd>
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
        v-if="order.status === 'READY'"
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
                Заказать доставку — {{ money(yandexQuote.price) }}
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
              <UInput v-model="form.courierName" required size="lg" />
            </UFormField>

            <UFormField label="Телефон курьера *" required>
              <UInput
                v-model="form.courierPhone"
                type="tel"
                required
                placeholder="+7 999 123-45-67"
                size="lg"
              />
            </UFormField>

            <UFormField label="Стоимость курьера, ₽ (необязательно)">
              <UInput
                v-model.number="form.priceRubles"
                type="number"
                min="0"
                step="0.01"
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
              Сохранить доставку
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
import type {
  DeliveryProvider,
  OrderItemStatus,
  StaffOrderDetail,
  Unit,
  YandexQuote,
} from '~/types/order'
import { useAuthStore } from '~/stores/auth'
import { apiError } from '~/utils/api-error'
import { deliveryProvider, deliveryStatus } from '~/utils/delivery'
import { money } from '~/utils/money'
import { orderStatus } from '~/utils/order'

interface DeliveryForm {
  provider: DeliveryProvider
  trackingUrl: string
  externalOrderId: string
  courierName: string
  courierPhone: string
  priceRubles: number | undefined
}

type StageId = 'details' | 'assembly' | 'summary' | 'delivery'

interface StageLink {
  id: StageId
  number: number
  label: string
  hash: string
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
const actual = reactive<Record<number, number>>({})
const itemLoading = ref<number | null>(null)
const actionLoading = ref<string | null>(null)
const deliveryLoading = ref(false)
const yandexQuote = ref<YandexQuote | null>(null)

const form = reactive<DeliveryForm>({
  provider: 'YANDEX',
  trackingUrl: '',
  externalOrderId: '',
  courierName: '',
  courierPhone: '',
  priceRubles: undefined,
})

const providerOptions = [
  { label: deliveryProvider.YANDEX, value: 'YANDEX' },
  { label: deliveryProvider.OTHER, value: 'OTHER' },
]

const baseStages: StageLink[] = [
  { id: 'details', number: 1, label: 'Данные заказа', hash: '#order-data' },
  { id: 'assembly', number: 2, label: 'Сборка', hash: '#assembly' },
  { id: 'summary', number: 3, label: 'Итог заказа', hash: '#order-summary' },
]

watch(
  () => order.value.items,
  (items) => {
    for (const item of items) {
      actual[item.id] = item.actualQty ?? item.qty
    }
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
      delivery.price === null ? undefined : delivery.price / 100
  },
  { immediate: true },
)

const pending = computed(
  () => order.value.items.filter((item) => item.status === 'PENDING').length,
)

const cancelable = computed(
  () =>
    ['NEW', 'CONFIRMED', 'ASSEMBLING', 'READY'].includes(order.value.status) &&
    !(
      order.value.delivery?.provider === 'YANDEX' &&
      order.value.delivery.externalOrderId
    ),
)

const canHandoff = computed(
  () =>
    order.value.status === 'READY' &&
    order.value.type === 'DELIVERY' &&
    order.value.delivery?.provider === 'OTHER' &&
    order.value.delivery?.status === 'ASSIGNED',
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

const stages = computed<StageLink[]>(() =>
  order.value.type === 'DELIVERY'
    ? [
        ...baseStages,
        { id: 'delivery', number: 4, label: 'Доставка', hash: '#delivery' },
      ]
    : baseStages,
)

const activeStage = computed<StageId>(() => {
  if (order.value.status === 'ASSEMBLING') return 'assembly'

  if (
    order.value.type === 'DELIVERY' &&
    ['READY', 'DELIVERING'].includes(order.value.status)
  ) {
    return 'delivery'
  }

  if (['NEW', 'CONFIRMED'].includes(order.value.status)) return 'details'

  return 'summary'
})

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
    order.value.city,
    order.value.street,
    order.value.house ? `д. ${order.value.house}` : null,
    order.value.flat ? `кв. ${order.value.flat}` : null,
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
      ? `Адрес: ${[order.value.city, order.value.street, order.value.house]
          .filter(Boolean)
          .join(', ')}`
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
  const changed = await runAction('finish', 'assembly/finish', 'Заказ собран')

  if (changed && order.value.type === 'DELIVERY') {
    await goToDelivery()
  }
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
  actionLoading.value = 'yandex-order'

  try {
    await api(`/staff/orders/${id}/delivery/yandex/order`, { method: 'POST' })
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

  const price = form.priceRubles

  if (price !== undefined && (!Number.isFinite(price) || price < 0)) {
    toast.add({
      title: 'Укажите корректную неотрицательную стоимость',
      color: 'error',
    })
    return
  }

  const priceKopecks =
    price === undefined ? undefined : Math.round((price + Number.EPSILON) * 100)

  deliveryLoading.value = true

  try {
    await api(`/staff/orders/${id}/delivery`, {
      method: 'PUT',
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

function quantity(value: number, unit: Unit) {
  if (unit === 'GRAM') {
    return value >= 1000
      ? `${(value / 1000).toLocaleString('ru-RU')} кг`
      : `${value} г`
  }

  if (unit === 'BUNCH') return `${value} пуч.`
  if (unit === 'PACK') return `${value} уп.`

  return `${value} шт.`
}

function itemPrice(item: StaffOrderDetail['items'][number]) {
  return `${money(item.price)} / ${quantity(item.priceQty, item.unit)}`
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
  max-width: 1100px;
  padding-block: 1.5rem 5rem;
}

.workspace__back {
  color: var(--ui-text-muted);
}

.workspace__bar {
  position: sticky;
  z-index: 20;
  top: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1.5rem;
  margin: 1rem -1rem 1.5rem;
  padding: 1rem;
  border: 1px solid var(--ui-border);
  border-radius: 1rem;
  background: color-mix(in srgb, var(--ui-bg) 94%, transparent);
  box-shadow: 0 12px 32px rgb(0 0 0 / 8%);
  backdrop-filter: blur(12px);
}

.workspace__identity {
  display: grid;
  gap: 0.75rem;
}

.workspace__number,
.delivery__label {
  color: var(--ui-primary);
  font-weight: 600;
}

.workspace__title {
  font-size: clamp(1.5rem, 4vw, 2rem);
  font-weight: 700;
}

.workspace__badges,
.workspace__actions,
.copy-card__actions,
.delivery-card__actions,
.delivery-form__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
}

.workspace__actions {
  justify-content: flex-end;
}

.workspace__alert {
  margin-top: 1.5rem;
}

.stages {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 0.75rem;
}

.stages__link {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  padding: 0.75rem;
  border: 1px solid var(--ui-border);
  border-radius: 0.875rem;
  color: var(--ui-text-muted);
  font-weight: 600;
}

.stages__link--active {
  border-color: var(--ui-primary);
  background: color-mix(in srgb, var(--ui-primary) 10%, var(--ui-bg));
  color: var(--ui-primary);
}

.stages__number {
  display: grid;
  width: 1.75rem;
  height: 1.75rem;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 999px;
  background: var(--ui-bg-elevated);
}

.stage {
  display: grid;
  gap: 1rem;
  margin-top: 2rem;
  padding: 1rem;
  scroll-margin-top: 10rem;
  border: 2px solid transparent;
  border-radius: 1.25rem;
}

.stage.stage--active {
  border-color: var(--ui-primary);
  background: color-mix(in srgb, var(--ui-primary) 6%, var(--ui-bg));
  box-shadow: 0 14px 40px rgb(0 0 0 / 8%);
}

.stage__number {
  color: var(--ui-primary);
  font-size: 0.8rem;
  font-weight: 700;
  text-transform: uppercase;
}

.stage__title {
  margin-top: 0.25rem;
  font-size: 1.5rem;
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
}

.customer {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 1rem;
  padding: 1.5rem;
}

.customer > div,
.item__stats > div,
.delivery-card__details > div {
  display: grid;
  align-content: start;
  gap: 0.25rem;
}

.customer__label,
.item__stats dt,
.delivery-card__details dt {
  color: var(--ui-text-muted);
  font-size: 0.8rem;
}

.items {
  display: grid;
  gap: 1rem;
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

.item__stats,
.delivery-card__details,
.delivery-form__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 1rem;
}

.item__stats dd,
.delivery-card__details dd {
  font-weight: 600;
}

.item__actions {
  display: flex;
  align-items: flex-end;
  flex-wrap: wrap;
  gap: 0.75rem;
  padding-top: 1rem;
  border-top: 1px solid var(--ui-border);
}

.item__input {
  min-width: 190px;
}

.summary {
  display: grid;
  gap: 1rem;
  padding: 1.5rem;
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

.delivery {
  display: grid;
  gap: 1rem;
  padding: 1.5rem;
}

.delivery__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
}

.delivery__title {
  margin-top: 0.25rem;
  font-size: 1.75rem;
  font-weight: 700;
}

.delivery__description,
.delivery-form__description {
  margin-top: 0.5rem;
  color: var(--ui-text-muted);
}

.copy-card,
.delivery-card,
.delivery-form,
.yandex-delivery {
  display: grid;
  gap: 1.25rem;
  padding: 1.25rem;
}

.copy-card__title,
.delivery-form__title {
  font-size: 1.125rem;
  font-weight: 700;
}

.delivery-form__grid--provider {
  max-width: 360px;
}

.yandex-delivery {
  padding: 0;
}

.yandex-delivery__quote {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
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

@media (max-width: 760px) {
  .workspace__bar {
    align-items: stretch;
    flex-direction: column;
    margin-inline: 0;
  }

  .workspace__actions > *,
  .item__actions > *,
  .copy-card__actions > *,
  .delivery-form__actions > * {
    width: 100%;
    justify-content: center;
  }

  .item__input {
    width: 100%;
  }

  .stage {
    padding-inline: 0.5rem;
  }
}
</style>
