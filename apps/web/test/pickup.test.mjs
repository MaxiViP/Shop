import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { compareQueue } from '../app/utils/queue.ts'
import { pickupDate, pickupTime } from '../app/utils/pickup.ts'

test('ASAP pickup first, oldest first; scheduled by time; DELIVERY order preserved', () => {
  const orders = [
    { id: 1, type: 'DELIVERY', deliveryAt: null, createdAt: '2026-09-05T08:00:00Z' },
    { id: 2, type: 'PICKUP', deliveryAt: null, createdAt: '2026-09-05T10:00:00Z' },
    { id: 3, type: 'PICKUP', deliveryAt: null, createdAt: '2026-09-05T09:00:00Z' },
    { id: 4, type: 'PICKUP', deliveryAt: '2026-09-05T15:00:00Z', createdAt: '2026-09-05T08:00:00Z' },
    { id: 5, type: 'DELIVERY', deliveryAt: '2026-09-05T14:00:00Z', createdAt: '2026-09-05T08:00:00Z' },
  ]
  assert.deepEqual(orders.sort(compareQueue).map(order => order.id), [3, 2, 5, 4, 1])
  assert.ok(compareQueue({ ...orders[0], id: 10 }, { ...orders[0], id: 11 }) < 0)
})

test('pickup input is Moscow time and invalid calendar dates are rejected', () => {
  assert.equal(pickupDate('2099-09-05T18:30')?.toISOString(), '2099-09-05T15:30:00.000Z')
  for (const value of ['', 'invalid', '2099-02-30T12:00', '2099-09-05T25:00']) {
    assert.equal(pickupDate(value), null)
  }
  assert.match(pickupTime('2099-09-05T15:30:00.000Z'), /18:30/)
})

test('staff queue follows backend rank and flags a scheduled order only when preparation is due', async () => {
  const base = { type: 'PICKUP', deliveryAt: null, createdAt: '2026-10-02T09:00:00Z' }
  const orders = [
    { ...base, id: 1, status: 'NEW', queueRank: 2 },
    { ...base, id: 2, status: 'CONFIRMED', queueRank: null, scheduledFor: '2026-10-03T12:00:00Z' },
    { ...base, id: 3, status: 'CONFIRMED', queueRank: 1, scheduledFor: '2026-10-02T10:00:00Z' },
    { ...base, id: 4, status: 'ASSEMBLING', queueRank: null },
  ]
  assert.deepEqual(orders.sort(compareQueue).map(order => order.id), [4, 3, 1, 2])
  const queue = await readFile(new URL('../app/pages/staff/orders/index.vue', import.meta.url), 'utf8')
  assert.match(queue, /order\.queueRank === 1/)
  assert.match(queue, /order\.fulfillmentMode === 'SCHEDULED' && !due\(order\)/)
  assert.match(queue, /timer = setInterval\(\(\) => \{ clock\.value = Date\.now\(\); void refresh\(\) \}, 30_000\)/)
})
