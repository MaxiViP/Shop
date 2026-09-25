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
  cancellations: Cancellation[]
  restoreProblem: string | null
  issues?: { id: number; status: string }[]
  staffUnread?: number
  finalSubtotal: number | null
  payment: OrderPayment | null
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

  total: number | null
  finalTotal: number | null
  createdAt: string

  delivery: Pick<DeliveryInfo, 'provider' | 'status' | 'externalOrderId'> | null

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
  deliveryPrice: number | null
  total: number | null

  createdAt: string

  items: {
    id: number
    productName: string
    qty: number
    total: number
  }[]
}

export interface OrderSummary {
  issues?: { id: number; status: string }[]
  customerUnread?: number
  subtotal: number
  finalSubtotal: number | null
  payment: OrderPayment | null
  id: number
  publicId: string
  type: OrderType
  status: OrderStatus

  total: number | null
  finalTotal: number | null
  deliveryAt: string | null
  createdAt: string

  items: {
    id: number
    productName: string
    qty: number
  }[]
}

export interface OrderDetail {
  extras?: OrderExtra[]
  issues: {
    orderItemId: number
    replacementItemId: number | null
    type: 'WEIGHT_DEVIATION' | 'MISSING_ITEM' | 'REPLACEMENT'
    status: 'WAITING_CUSTOMER' | 'WAITING_SELLER' | 'RESOLVED' | 'CANCELED'
    resolution: string | null
    actualQty: number | null
    approvedActualQty: number | null
    proposedName: string | null
    proposedQty: number | null
    proposedUnit: Unit | null
    proposedPrice: number | null
    proposedPriceQty: number | null
  }[]
  weightToleranceBps: number
  assemblyFinalizedAt: string | null
  payment: OrderPayment | null
  paymentDetails: PaymentDetails | null
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
  deliveryPrice: number | null
  total: number | null
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

export interface OrderExtra {
  id: number
  title: string
  comment: string | null
  quantity: number
  unitPrice: number
  amount: number
  status?: 'ACTIVE' | 'CANCELED'
  version?: number
}

export interface StaffOrderDetail extends OrderDetail {
  cancellations: Cancellation[]
  restoreProblem: string | null
  delivery: StaffDelivery | null
}

export interface Cancellation {
  id: number
  fromStatus: OrderStatus
  reason: string | null
  canceledAt: string
  canceledByRole: 'USER' | 'SELLER' | 'ADMIN'
  canceledBy: { id: number; name: string | null } | null
  restoredAt: string | null
  restoredByRole: 'USER' | 'SELLER' | 'ADMIN' | null
  restoredBy: { id: number; name: string | null } | null
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
    deliveryPrice: number | null
    total: number | null
    finalSubtotal: number | null
    finalTotal: number | null
  }
}

export type PaymentMethod = 'SBP' | 'QR' | 'CARD_TRANSFER'
export interface OrderPayment {
  amount: number
  status: 'AWAITING' | 'REPORTED' | 'PAID' | 'CANCELED'
  method: PaymentMethod | null
  reportedAt: string | null
  confirmedAt: string | null
  confirmedBy: { id: number; name: string | null } | null
}
export interface PaymentDetails {
  recipientName: string | null
  bankName: string | null
  phone: string | null
  cardNumber: string | null
  sbpLink: string | null
  qrImageUrl: string | null
  methods: PaymentMethod[]
}
