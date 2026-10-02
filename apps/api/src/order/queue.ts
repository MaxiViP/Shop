import { ConflictException, Injectable } from '@nestjs/common';
import type { Prisma, ShopSettings } from '../db/gen/client.js';
import { DbService } from '../db/db.service.js';
import { addDays, loadCalendar, localInstant, marketStatusAt, moscowDay, moscowMinute } from '../admin/shop-hours.js';

type Waiting = { id: number; createdAt: Date; fulfillmentMode: 'ASAP' | 'SCHEDULED'; scheduledFor: Date | null };
type Active = { assemblyStartedAt: Date | null };
const waitingStatus = ['NEW', 'CONFIRMED'] as const;
const finishedStatus = ['COMPLETED', 'CANCELED'] as const;
const MINUTE = 60_000;

export function peakActive(settings: Pick<ShopSettings, 'peakModeEnabled' | 'peakModeStart' | 'peakModeEnd'>, now: Date) {
  return settings.peakModeEnabled && !!settings.peakModeStart && !!settings.peakModeEnd &&
    settings.peakModeStart <= now && now < settings.peakModeEnd;
}

export function assemblyMinutes(durations: number[], fallback: number) {
  const valid = durations.filter(value => value >= 3 && value <= 360).sort((a, b) => a - b);
  if (valid.length < 5) return fallback;
  const middle = Math.floor(valid.length / 2);
  return Math.round(valid.length % 2 ? valid[middle]! : (valid[middle - 1]! + valid[middle]!) / 2);
}

// scheduledFor is the promised ready-by time, not the start of assembly.
// Scheduled orders enter the actionable queue at scheduledFor minus preparation lead.
// Once due, earliest promised preparation deadline is served first; ASAP keeps FIFO.
export function actionableQueue(rows: Waiting[], now: Date, minutes: number) {
  const due = rows.filter(row => row.fulfillmentMode === 'ASAP' ||
    (row.scheduledFor !== null && row.scheduledFor.getTime() - minutes * MINUTE <= now.getTime()));
  return due.sort((a, b) => {
    if (a.fulfillmentMode !== b.fulfillmentMode) return a.fulfillmentMode === 'SCHEDULED' ? -1 : 1;
    if (a.fulfillmentMode === 'SCHEDULED' && b.fulfillmentMode === 'SCHEDULED')
      return a.scheduledFor!.getTime() - b.scheduledFor!.getTime() || a.id - b.id;
    return a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id;
  });
}

export function waitRange(position: number, active: Active[], now: Date, minutes: number, workers = 1) {
  const capacity = Number.isSafeInteger(workers) && workers > 0 ? workers : 1;
  const completions = active.map(row => Math.max(0,
    minutes - (row.assemblyStartedAt ? (now.getTime() - row.assemblyStartedAt.getTime()) / MINUTE : 0)));
  let estimate = 0;
  for (let i = 0; i < position; i++) {
    while (completions.length >= capacity) {
      const next = Math.min(...completions);
      completions.splice(completions.indexOf(next), 1);
      estimate = Math.max(estimate, next);
    }
    completions.push(estimate + minutes);
  }
  return { min: Math.max(0, Math.floor(estimate * 0.75 / 5) * 5),
    max: Math.max(10, Math.ceil((estimate * 1.35 + 5) / 5) * 5) };
}

@Injectable()
export class QueueService {
  constructor(private readonly db: DbService) {}

  async snapshot(db: Prisma.TransactionClient = this.db, now = new Date()) {
    const [settings, rows, active, completed] = await Promise.all([
      db.shopSettings.findUniqueOrThrow({ where: { id: 1 } }),
      db.order.findMany({ where: { status: { in: [...waitingStatus] } },
        select: { id: true, createdAt: true, fulfillmentMode: true, scheduledFor: true } }),
      db.order.findMany({ where: { status: 'ASSEMBLING' }, select: { assemblyStartedAt: true } }),
      db.order.findMany({ where: { assemblyStartedAt: { not: null }, assemblyFinalizedAt: { not: null } },
        orderBy: { assemblyFinalizedAt: 'desc' }, take: 40,
        select: { assemblyStartedAt: true, assemblyFinalizedAt: true } }),
    ]);
    const minutes = assemblyMinutes(completed.map(row =>
      (row.assemblyFinalizedAt!.getTime() - row.assemblyStartedAt!.getTime()) / MINUTE),
    settings.assemblyFallbackMinutes);
    const queue = actionableQueue(rows, now, minutes);
    return { settings, rows, active, minutes, queue,
      queueLength: queue.length, peakModeActive: peakActive(settings, now),
      showScheduledOffer: queue.length >= settings.queueThreshold || peakActive(settings, now) };
  }

  async publicView(orderId?: number, db: Prisma.TransactionClient = this.db,
    now = new Date(), includeSlots = false, existingScheduled = false, includeFull = false) {
    const state = await this.snapshot(db, now);
    const position = orderId ? state.queue.findIndex(row => row.id === orderId) + 1 : state.queue.length + 1;
    return { queueLength: state.queueLength, position: position || null,
      wait: position ? waitRange(position, state.active, now, state.minutes,
        state.settings.assemblyConcurrency) : null,
      estimatedAssemblyMinutes: state.minutes,
      assemblyConcurrency: state.settings.assemblyConcurrency,
      showScheduledOffer: state.showScheduledOffer, peakModeActive: state.peakModeActive,
      slots: includeSlots && (state.showScheduledOffer || existingScheduled)
        ? await this.slots(db, state.settings, state.minutes, now, includeFull) : [] };
  }

  async slots(db: Prisma.TransactionClient, settings: ShopSettings, minutes: number, now: Date,
    includeFull = false) {
    const calendar = await loadCalendar(db);
    const end = localInstant(addDays(moscowDay(now), 7), 0);
    const booked = await db.order.findMany({
      where: { fulfillmentMode: 'SCHEDULED', status: { notIn: [...finishedStatus] },
        scheduledFor: { gte: now, lt: end } }, select: { scheduledFor: true },
    });
    const counts = new Map<number, number>();
    for (const row of booked) if (row.scheduledFor)
      counts.set(row.scheduledFor.getTime(), (counts.get(row.scheduledFor.getTime()) ?? 0) + 1);
    const slots: { at: string; reserved: number; capacity: number }[] = [];
    for (let day = 0; day < 7; day++) {
      const date = addDays(moscowDay(now), day);
      for (let minute = 0; minute < 1440; minute += settings.slotIntervalMinutes) {
        const at = localInstant(date, minute);
        if (at.getTime() < now.getTime() + (minutes + 10) * MINUTE ||
          !marketStatusAt(calendar, at).isOpen ||
          !marketStatusAt(calendar, new Date(at.getTime() - minutes * MINUTE)).isOpen) continue;
        const reserved = counts.get(at.getTime()) ?? 0;
        if (includeFull || reserved < settings.slotCapacity)
          slots.push({ at: at.toISOString(), reserved, capacity: settings.slotCapacity });
      }
    }
    return slots;
  }

  async reserve(db: Prisma.TransactionClient, at: Date, settings: ShopSettings, now: Date,
    excludeId?: number, allowExisting = false) {
    const state = await this.snapshot(db, now);
    if (!state.showScheduledOffer && !allowExisting)
      throw new ConflictException('Заказ ко времени сейчас недоступен');
    if (!Number.isFinite(at.getTime()) || at.getTime() < now.getTime() + (state.minutes + 10) * MINUTE ||
      at.getUTCSeconds() || at.getUTCMilliseconds() ||
      moscowMinute(at) % settings.slotIntervalMinutes)
      throw new ConflictException('Выберите доступное время подготовки заказа');
    const calendar = await loadCalendar(db);
    if (!marketStatusAt(calendar, at).isOpen ||
      !marketStatusAt(calendar, new Date(at.getTime() - state.minutes * MINUTE)).isOpen ||
      at >= localInstant(addDays(moscowDay(now), 7), 0))
      throw new ConflictException('Выбранное время вне графика магазина');
    const count = await db.order.count({ where: { fulfillmentMode: 'SCHEDULED',
      scheduledFor: at, status: { notIn: [...finishedStatus] },
      ...(excludeId ? { id: { not: excludeId } } : {}) } });
    if (count >= settings.slotCapacity) throw new ConflictException('Это время уже занято. Выберите другое.');
  }
}
