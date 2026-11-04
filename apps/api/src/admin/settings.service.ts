import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { adminPhone } from '../auth/admin.config.js';
import { dbError } from './errors.js';
import { effectivePercent } from '../product/pricing.js';
import type { SettingsInput } from './settings.schema.js';
import { DbService } from '../db/db.service.js';
import { effectiveQueue, QueueService } from '../order/queue.js';
import { loadCalendar, marketStatusAt } from './shop-hours.js';
@Injectable()
export class SettingsService {
  constructor(private readonly db: DbService) {}
  get() {
    return this.db.shopSettings.findUniqueOrThrow({ where: { id: 1 } });
  }
  queue() { return new QueueService(this.db).adminView(); }
  update(input: SettingsInput, updatedById: number) {
    return this.db.$transaction(async (db) => {
      if (input.globalServiceMarkupPercent !== undefined) {
        effectivePercent(null, input.globalServiceMarkupPercent);
        const [actor] = await db.$queryRaw<{ role: string; phone: string | null }[]>`
          SELECT role, phone FROM "User" WHERE id = ${updatedById} FOR SHARE NOWAIT`;
        if (actor?.role !== 'ADMIN' || !actor.phone || actor.phone !== adminPhone()) throw new ForbiddenException();
        // Never queue behind checkout or wait on settings while holding Product.
        // NOWAIT on both locks avoids cycles through settings -> order -> product too.
        await db.$executeRaw`LOCK TABLE "Product" IN EXCLUSIVE MODE NOWAIT`;
        await db.$queryRaw`SELECT id FROM "ShopSettings" WHERE id = 1 FOR UPDATE NOWAIT`;
      } else await db.$queryRaw`SELECT id FROM "ShopSettings" WHERE id = 1 FOR UPDATE`;
      const current = await db.shopSettings.findUniqueOrThrow({
        where: { id: 1 },
      });
      const next = { ...current, ...input,
        peakModeStart: input.peakModeStart === undefined ? current.peakModeStart : input.peakModeStart ? new Date(input.peakModeStart) : null,
        peakModeEnd: input.peakModeEnd === undefined ? current.peakModeEnd : input.peakModeEnd ? new Date(input.peakModeEnd) : null,
      };
      if (!next.deliveryEnabled && !next.pickupEnabled)
        throw new BadRequestException(
          'Должен быть доступен хотя бы один способ получения заказа.',
        );
      if (next.maxOrderExtrasTotal < next.maxOrderExtraUnitPrice)
        throw new BadRequestException(
          'Общий лимит услуг не может быть меньше лимита цены одной услуги.',
        );
      if (next.freeDeliveryEnabled && !next.freeDeliveryThreshold)
        throw new BadRequestException('Укажите положительный порог бесплатной доставки.');
      if (next.peakModeEnabled && (!next.peakModeStart || !next.peakModeEnd ||
        new Date(next.peakModeEnd) <= new Date(next.peakModeStart)))
        throw new BadRequestException('Укажите начало и окончание периода повышенной нагрузки.');
      if (['slotCapacity', 'peakSlotCapacity', 'peakModeEnabled', 'peakModeStart', 'peakModeEnd',
        'assemblyFallbackMinutes', 'peakAssemblyMinutes'].some(key => key in input)) {
        const bookings = await db.order.groupBy({
          by: ['scheduledFor'],
          where: { fulfillmentMode: 'SCHEDULED', scheduledFor: { gte: new Date() },
            status: { notIn: ['COMPLETED', 'CANCELED'] } },
          _count: { id: true },
        });
        const calendar = bookings.length ? await loadCalendar(db) : null;
        for (const booking of bookings) {
          if (!booking.scheduledFor) continue;
          const profile = effectiveQueue(next, booking.scheduledFor);
          if (booking._count.id > profile.slotCapacity)
            throw new ConflictException('Новая вместимость меньше числа уже записанных заказов на одно время.');
          const before = effectiveQueue(current, booking.scheduledFor);
          if (calendar && profile.assemblyMinutes > before.assemblyMinutes &&
            marketStatusAt(calendar, new Date(booking.scheduledFor.getTime() - before.assemblyMinutes * 60_000)).isOpen &&
            !marketStatusAt(calendar, new Date(booking.scheduledFor.getTime() - profile.assemblyMinutes * 60_000)).isOpen)
            throw new ConflictException('Новое время сборки затронет уже принятый заказ ко времени.');
        }
      }
      if (input.globalServiceMarkupPercent !== undefined) {
        const drift = await db.$queryRaw<{ id: number }[]>`
          SELECT id FROM "Product" WHERE "serviceMarkupPercentOverride" IS NOT NULL
          AND "serviceMarkupPercent" <> "serviceMarkupPercentOverride" LIMIT 1`;
        if (drift.length) throw new ConflictException('Обнаружены несогласованные индивидуальные проценты. Проверьте товары.');
      }
      const saved = await db.shopSettings.update({
        where: { id: 1 }, data: { ...input, updatedById },
      });
      if (current.globalServiceMarkupPercent !== saved.globalServiceMarkupPercent) {
        const products = await db.product.findMany({ where: { serviceMarkupPercentOverride: null },
          select: { id: true, serviceMarkupPercent: true, serviceMarkupNeedsReview: true }, orderBy: { id: 'asc' } });
        await db.product.updateMany({ where: { serviceMarkupPercentOverride: null },
          data: { serviceMarkupPercent: effectivePercent(null, saved.globalServiceMarkupPercent) } });
        await db.adminAudit.create({ data: { actorId: updatedById, action: 'GLOBAL_MARKUP_CHANGED', entity: 'SHOP_SETTINGS',
          entityId: '1', oldValue: current.globalServiceMarkupPercent, newValue: saved.globalServiceMarkupPercent } });
        const changed = products.filter(product => product.serviceMarkupPercent !== saved.globalServiceMarkupPercent);
        if (changed.length) await db.adminAudit.createMany({ data: changed.map(product => ({ actorId: updatedById,
          action: 'PRODUCT_MARKUP_CHANGED', entity: 'PRODUCT', entityId: String(product.id),
          oldValue: { serviceMarkupPercentOverride: null, serviceMarkupPercent: product.serviceMarkupPercent,
            serviceMarkupNeedsReview: product.serviceMarkupNeedsReview },
          newValue: { serviceMarkupPercentOverride: null, serviceMarkupPercent: saved.globalServiceMarkupPercent,
            serviceMarkupNeedsReview: product.serviceMarkupNeedsReview } })) });
      }
      if (current.partner1Name !== saved.partner1Name || current.partner2Name !== saved.partner2Name)
        await db.adminAudit.create({ data: {
          actorId: updatedById, action: 'PARTNER_NAMES_CHANGED', entity: 'SHOP_SETTINGS',
          entityId: '1',
          oldValue: { partner1Name: current.partner1Name, partner2Name: current.partner2Name },
          newValue: { partner1Name: saved.partner1Name, partner2Name: saved.partner2Name },
        } });
      return saved;
    }).catch(dbError);
  }
}
