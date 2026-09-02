<template>
  <UContainer v-if="tracking" class="tracking">
    <header class="tracking__head">
      <div>
        <p class="tracking__label">Заказ №{{ tracking.order.id }}</p>
        <h1 class="tracking__title">Доставка заказа</h1>
      </div>

      <OrderStatus :status="tracking.order.status" />
    </header>

    <section class="tracking__card">
      <dl class="tracking__details">
        <div>
          <dt>Статус доставки</dt>
          <dd>{{ deliveryStatus[tracking.status] }}</dd>
        </div>

        <div>
          <dt>Сервис</dt>
          <dd>{{ deliveryProvider[tracking.provider] }}</dd>
        </div>

        <div v-if="tracking.order.deliveryAt">
          <dt>Желаемое время</dt>
          <dd>{{ date(tracking.order.deliveryAt) }}</dd>
        </div>

        <div>
          <dt>Товары</dt>
          <dd>{{ money(tracking.order.finalSubtotal ?? tracking.order.subtotal) }}</dd>
        </div>

        <div>
          <dt>
            {{ tracking.provider === 'YANDEX' ? 'Доставка Яндекс' : 'Доставка' }}
          </dt>
          <dd>{{ money(tracking.order.deliveryPrice) }}</dd>
        </div>

        <div>
          <dt>Итого</dt>
          <dd>{{ money(tracking.order.finalTotal ?? tracking.order.total) }}</dd>
        </div>

        <div v-if="tracking.externalOrderId">
          <dt>Номер доставки</dt>
          <dd>{{ tracking.externalOrderId }}</dd>
        </div>

        <div v-if="tracking.courierName">
          <dt>Курьер</dt>
          <dd>{{ tracking.courierName }}</dd>
        </div>

        <div v-if="tracking.courierPhone">
          <dt>Телефон курьера</dt>
          <dd>
            <a :href="`tel:${tracking.courierPhone}`">
              {{ tracking.courierPhone }}
            </a>
          </dd>
        </div>
      </dl>

      <UButton
        v-if="tracking.trackingUrl"
        class="tracking__action"
        :to="tracking.trackingUrl"
        target="_blank"
        rel="noopener noreferrer"
        size="lg"
      >
        Открыть отслеживание курьера
      </UButton>
    </section>

    <p class="tracking__note">
      На этой странице нет персональных данных покупателя. Статус можно
      обновить, перезагрузив страницу.
    </p>
  </UContainer>
</template>

<script setup lang="ts">
import type { PublicTracking } from '~/types/order'
import { deliveryProvider, deliveryStatus } from '~/utils/delivery'
import { money } from '~/utils/money'

const route = useRoute()
const token = String(route.params.token)

const { data, error } = await useApi<PublicTracking>(`/track/${token}`)

if (error.value || !data.value) {
  throw createError({
    statusCode: 404,
    statusMessage: 'Доставка не найдена',
  })
}

const tracking = computed(() => data.value!)

function date(value: string) {
  return new Date(value).toLocaleString('ru-RU', {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

useSeoMeta({
  title: () => `Доставка заказа №${tracking.value.order.id}`,
  robots: 'noindex, nofollow',
})
</script>

<style scoped>
.tracking {
  max-width: 47.5rem;
  min-width: 0;
  padding-block: var(--page-start) var(--page-end);
}

.tracking__head {
  display: grid;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 2rem;
}

.tracking__label {
  color: var(--ui-primary);
  font-weight: 600;
}

.tracking__title {
  margin-top: 0.25rem;
  font-size: var(--page-title);
  font-weight: 700;
  line-height: 1.1;
}

.tracking__card {
  min-width: 0;
  padding: var(--card-padding);
  border: 1px solid var(--ui-border);
  border-radius: 1rem;
}

.tracking__details {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 10rem), 1fr));
  gap: 1.25rem;
}

.tracking__details > div {
  display: grid;
  gap: 0.25rem;
}

.tracking__details dt {
  color: var(--ui-text-muted);
  font-size: 0.8rem;
}

.tracking__details dd {
  font-weight: 600;
  overflow-wrap: anywhere;
}

.tracking__action {
  width: 100%;
  min-height: var(--touch-target);
  margin-top: 1.5rem;
  justify-content: center;
}

.tracking__note {
  margin-top: 1rem;
  color: var(--ui-text-muted);
  font-size: 0.8rem;
  overflow-wrap: anywhere;
}

@media (min-width: 40rem) {
  .tracking__head {
    display: flex;
  }
}
</style>
