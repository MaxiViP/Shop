export type OrderStatus =
  | 'NEW'
  | 'CONFIRMED'
  | 'ASSEMBLING'
  | 'READY'
  | 'DELIVERING'
  | 'COMPLETED'
  | 'CANCELED'

export type OrderType = 'DELIVERY' | 'PICKUP'

export type Unit = 'GRAM' | 'PIECE' | 'BUNCH' | 'PACK'

export type DeliveryProvider = 'YANDEX' | 'OTHER'

export type DeliveryStatus =
  'PENDING' | 'ASSIGNED' | 'PICKED_UP' | 'DELIVERED' | 'CANCELED'

export type OrderItemStatus = 'PENDING' | 'PICKED' | 'MISSING'

export interface DeliveryInfo {
  provider: DeliveryProvider
  status: DeliveryStatus
  externalOrderId: string | null
  trackingUrl: string | null
  courierName: string | null
  courierPhone: string | null
  price: number | null
  providerStatus: string | null
  syncedAt: string | null
}

export interface StaffDelivery extends DeliveryInfo {
  id: number
  publicToken: string
}

export interface YandexQuote {
  price: number
  currency: string
  pickupFrom: string
  pickupTo: string
  deliveryFrom: string
  deliveryTo: string
  expiresAt: string | null
}

export interface StaffOrder {
  id: number
  publicId: string
  type: OrderType
  status: OrderStatus

  customerName: string
  customerPhone: string

  city: string | null
  street: string | null
  house: string | null

  deliveryAt: string | null

  total: number
  finalTotal: number | null
  createdAt: string

  delivery: Pick<DeliveryInfo, 'provider' | 'status'> | null

  items: {
    id: number
    productName: string
    qty: number
    unit: Unit
    status: OrderItemStatus
  }[]
}

export interface OrderCreated {
  id: number
  publicId: string
  type: OrderType
  status: OrderStatus

  subtotal: number
  deliveryPrice: number
  total: number

  createdAt: string

  items: {
    id: number
    productName: string
    qty: number
    total: number
  }[]
}

export interface OrderSummary {
  id: number
  publicId: string
  type: OrderType
  status: OrderStatus

  total: number
  createdAt: string

  items: {
    id: number
    productName: string
    qty: number
  }[]
}

export interface OrderDetail {
  id: number
  publicId: string
  type: OrderType
  status: OrderStatus

  customerName: string
  customerPhone: string

  city: string | null
  street: string | null
  house: string | null
  flat: string | null
  entrance: string | null
  floor: string | null
  intercom: string | null
  comment: string | null

  deliveryAt: string | null

  subtotal: number
  deliveryPrice: number
  total: number
  finalSubtotal: number | null
  finalTotal: number | null

  createdAt: string
  updatedAt: string

  delivery: DeliveryInfo | null

  items: {
    id: number
    productName: string
    productSlug: string
    image: string | null

    price: number
    priceQty: number
    unit: Unit

    status: OrderItemStatus
    actualTotal: number | null

    qty: number
    actualQty: number | null
    total: number
  }[]
}

export interface StaffOrderDetail extends OrderDetail {
  delivery: StaffDelivery | null
}

export interface PublicTracking {
  provider: DeliveryProvider
  status: DeliveryStatus
  externalOrderId: string | null
  trackingUrl: string | null
  courierName: string | null
  courierPhone: string | null

  order: {
    id: number
    status: OrderStatus
    deliveryAt: string | null
    subtotal: number
    deliveryPrice: number
    total: number
    finalSubtotal: number | null
    finalTotal: number | null
  }
}
