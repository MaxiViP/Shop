import type { DeliveryProvider, DeliveryStatus } from '~/types/order'

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
