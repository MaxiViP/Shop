interface QueueOrder {
  id: number
  type: 'PICKUP' | 'DELIVERY'
  deliveryAt: string | null
  createdAt: string
  status?: string
  queueRank?: number | null
  scheduledFor?: string | null
}

export function compareQueue(a: QueueOrder, b: QueueOrder): number {
  if (a.status === 'ASSEMBLING' && b.status !== 'ASSEMBLING') return -1
  if (b.status === 'ASSEMBLING' && a.status !== 'ASSEMBLING') return 1
  if (a.queueRank !== undefined || b.queueRank !== undefined) {
    const rankA = a.queueRank ?? Number.MAX_SAFE_INTEGER
    const rankB = b.queueRank ?? Number.MAX_SAFE_INTEGER
    if (rankA !== rankB) return rankA - rankB
    const scheduledA = a.scheduledFor ? Date.parse(a.scheduledFor) : Number.MAX_SAFE_INTEGER
    const scheduledB = b.scheduledFor ? Date.parse(b.scheduledFor) : Number.MAX_SAFE_INTEGER
    if (scheduledA !== scheduledB) return scheduledA - scheduledB
  }
  const asapA = a.type === 'PICKUP' && a.deliveryAt === null
  const asapB = b.type === 'PICKUP' && b.deliveryAt === null
  if (asapA !== asapB) return asapA ? -1 : 1
  const timeA = a.deliveryAt ? Date.parse(a.deliveryAt) : Number.MAX_SAFE_INTEGER
  const timeB = b.deliveryAt ? Date.parse(b.deliveryAt) : Number.MAX_SAFE_INTEGER
  return timeA - timeB || Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id - b.id
}
