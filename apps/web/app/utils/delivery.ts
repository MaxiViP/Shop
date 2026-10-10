import type { DeliveryProvider, DeliveryStatus, OrderDetail } from '~/types/order'
import { knownMoney, money } from './money.ts'

export function deliveryCost(price: number | null) {
  return price === 0 ? 'Бесплатная доставка' : knownMoney(price, 'Рассчитывается после сборки')
}

// Use the saved customer price for orders, and the current server quote for checkout.
export function orderDeliveryMessage(order: Pick<OrderDetail, 'type' | 'deliveryPrice'>) {
  if (order.type === 'PICKUP') return 'Самовывоз — бесплатно. Оплачиваются только товары и услуги магазина.'
  if (order.deliveryPrice === 0) return 'Бесплатная доставка'
  if (order.deliveryPrice === null)
    return 'Доставка оплачивается отдельно. Стоимость рассчитывается после сборки по адресу и тарифу перевозчика.'
  return 'Доставка — ' + money(order.deliveryPrice) + '. Оплачивается отдельно от товаров и услуг магазина.'
}

export const deliveryProvider = {
  YANDEX: 'Яндекс Доставка',
  OTHER: 'Другая служба',
} as const satisfies Record<DeliveryProvider, string>

export const deliveryStatus = {
  PENDING: 'Ожидает оформления',
  ASSIGNED: 'Курьер назначен',
  PICKED_UP: 'Курьер в пути',
  DELIVERED: 'Доставлено',
  CANCELED: 'Доставка отменена',
} as const satisfies Record<DeliveryStatus, string>
