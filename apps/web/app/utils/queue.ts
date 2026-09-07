interface QueueOrder {
  id: number
  type: 'PICKUP' | 'DELIVERY'
  deliveryAt: string | null
  createdAt: string
}

export function compareQueue(a: QueueOrder, b: QueueOrder): number {
  const asapA = a.type === 'PICKUP' && a.deliveryAt === null
  const asapB = b.type === 'PICKUP' && b.deliveryAt === null
  if (asapA !== asapB) return asapA ? -1 : 1
  const timeA = a.deliveryAt ? Date.parse(a.deliveryAt) : Number.MAX_SAFE_INTEGER
  const timeB = b.deliveryAt ? Date.parse(b.deliveryAt) : Number.MAX_SAFE_INTEGER
  return timeA - timeB || Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id - b.id
}
