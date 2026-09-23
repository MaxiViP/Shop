import { HttpException, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { StaffTelegramSession } from '../db/gen/client.js';
import type { StaffActor } from '../staff/audit.js';
import { DbService } from '../db/db.service.js';
import { StaffService } from '../staff/staff.service.js';
import { deliverySchema } from '../staff/schema.js';
import { extraSchema } from '../staff/extra.js';
import { clean, money, positiveQty, rublesToKopecks, staffConfirmData, staffData, type StaffMessage } from './staff-bot.js';
import { TelegramService } from './telegram.service.js';

export type Flow = 'ITEM' | 'EXTRA' | 'DELIVERY' | 'CANCEL';
export type FlowPayload = {
  title?: string; quantity?: number; unitPrice?: number; comment?: string;
  extraId?: number; version?: number; courierName?: string; courierPhone?: string;
  price?: number; trackingUrl?: string; externalOrderId?: string; reason?: string;
};
const payloadSchema = z.object({
  title: z.string().max(120).optional(), quantity: z.number().int().optional(),
  unitPrice: z.number().int().optional(), comment: z.string().max(1000).optional(),
  extraId: z.number().int().positive().optional(), version: z.number().int().positive().optional(),
  courierName: z.string().max(100).optional(), courierPhone: z.string().max(30).optional(),
  price: z.number().int().optional(), trackingUrl: z.string().max(500).optional(),
  externalOrderId: z.string().max(100).optional(), reason: z.string().max(1000).optional(),
}).strict();

@Injectable()
export class StaffBotFlowService {
  private readonly logger = new Logger(StaffBotFlowService.name);
  constructor(private readonly db: DbService, private readonly staff: StaffService,
    private readonly telegram: TelegramService) {}

  async cancel(identityId: number, orderId?: number): Promise<void> {
    await this.db.staffTelegramSession.deleteMany({
      where: { identityId, ...(orderId ? { orderId } : {}) },
    });
  }

  async start(identityId: number, chatId: number, dashboardMessageId: number,
    orderId: number, itemId: number | null, action: Flow, step: string, prompt: string,
    payload: FlowPayload = {}): Promise<boolean> {
    const promptMessageId = await this.telegram.promptStaff(chatId, prompt + '\n/cancel — отменить ввод');
    if (!promptMessageId) return false;
    await this.db.staffTelegramSession.upsert({
      where: { identityId },
      create: { identityId, orderId, itemId, action, step, promptMessageId,
        dashboardMessageId, confirmationCode: null, payload,
        expiresAt: new Date(Date.now() + 15 * 60_000) },
      update: { orderId, itemId, action, step, promptMessageId, dashboardMessageId,
        confirmationCode: null, payload, expiresAt: new Date(Date.now() + 15 * 60_000) },
    });
    return true;
  }

  async input(message: StaffMessage, identityId: number, actor: StaffActor):
    Promise<{ orderId: number; dashboardMessageId: number | null } | null> {
    const session = await this.db.staffTelegramSession.findUnique({ where: { identityId } });
    if (!session) return null;
    if (session.expiresAt <= new Date()) {
      await this.cancel(identityId);
      await this.telegram.sendStaff(message.chat.id, 'Время ввода истекло. Откройте заказ заново.');
      return null;
    }
    if (!message.reply_to_message || message.reply_to_message.message_id !== session.promptMessageId)
      return null;
    const claimed = await this.db.staffTelegramSession.updateMany({
      where: { identityId, promptMessageId: session.promptMessageId,
        step: session.step, expiresAt: { gt: new Date() } },
      data: { step: 'BUSY' },
    });
    if (claimed.count !== 1) return null;
    try {
      return await this.processInput(message, identityId, actor, session);
    } catch (error) {
      await this.db.staffTelegramSession.deleteMany({ where: { identityId, step: 'BUSY' } });
      const text = error instanceof HttpException && error.getStatus() === 403 ? 'Нет доступа' :
        error instanceof HttpException && [400, 404, 409].includes(error.getStatus())
          ? 'Заказ изменился. Обновите его и повторите действие.'
          : 'Не удалось выполнить действие. Откройте заказ заново.';
      if (!(error instanceof HttpException)) this.logger.error('Staff Telegram input failed');
      await this.telegram.sendStaff(message.chat.id, text);
      return null;
    }
  }

  private async processInput(message: StaffMessage, identityId: number, actor: StaffActor,
    session: StaffTelegramSession): Promise<{ orderId: number; dashboardMessageId: number | null } | null> {
    const text = message.text?.trim() ?? '';
    const chatId = message.chat.id;
    const parsed = payloadSchema.safeParse(session.payload);
    if (!parsed.success) throw new Error('Invalid stored flow');
    const payload: FlowPayload = parsed.data;
    if (session.action === 'ITEM' && session.step === 'qty' && session.itemId) {
      const actualQty = positiveQty(text);
      if (!actualQty) return this.retry(identityId, chatId, session, 'Введите положительное целое количество.');
      const order = await this.staff.get(session.orderId);
      const item = order.items.find(value => value.id === session.itemId);
      if (!item || order.status !== 'ASSEMBLING' || item.status !== 'PENDING')
        throw new Error('Stale item');
      const consumed = await this.db.staffTelegramSession.deleteMany({
        where: { identityId, step: 'BUSY', orderId: session.orderId,
          promptMessageId: session.promptMessageId },
      });
      if (consumed.count !== 1) return null;
      await this.staff.item(session.orderId, item.id, { status: 'PICKED', actualQty }, actor.userId, actor);
      return { orderId: session.orderId, dashboardMessageId: session.dashboardMessageId };
    }
    if (session.action === 'CANCEL' && session.step === 'reason') {
      if (!text || text.length > 1000)
        return this.retry(identityId, chatId, session, 'Укажите причину отмены (1–1000 символов).');
      await this.confirm(identityId, chatId, session, { reason: text },
        'Отменить заказ #' + session.orderId + '?\nПричина: ' + clean(text, 500), 'zy');
      return null;
    }
    if (session.action === 'EXTRA') {
      if (session.step === 'title') {
        if (!text || text.length > 120)
          return this.retry(identityId, chatId, session, 'Введите название (1–120 символов).');
        await this.next(identityId, chatId, session, 'quantity', { ...payload, title: text },
          'Введите количество целым числом (1–10000).');
        return null;
      }
      if (session.step === 'quantity') {
        const quantity = positiveQty(text, 10_000);
        if (!quantity) return this.retry(identityId, chatId, session, 'Введите количество от 1 до 10000.');
        await this.next(identityId, chatId, session, 'price', { ...payload, quantity },
          'Введите цену за единицу в рублях, например 120,50.');
        return null;
      }
      if (session.step === 'price') {
        const unitPrice = rublesToKopecks(text);
        if (!unitPrice) return this.retry(identityId, chatId, session, 'Введите положительную цену в рублях.');
        await this.next(identityId, chatId, session, 'comment', { ...payload, unitPrice },
          'Комментарий (до 1000 символов) или - чтобы пропустить.');
        return null;
      }
      if (session.step === 'comment') {
        if (text.length > 1000) return this.retry(identityId, chatId, session, 'Комментарий слишком длинный.');
        const data = { ...payload, comment: text === '-' ? '' : text };
        await this.confirm(identityId, chatId, session, data,
          'Сохранить доп. позицию?\n' + clean(data.title, 120) + ' · ' + data.quantity +
          ' × ' + money(data.unitPrice), 'xs');
        return null;
      }
    }
    if (session.action === 'DELIVERY') {
      if (session.step === 'courierName') {
        if (!text || text.length > 100) return this.retry(identityId, chatId, session, 'Введите имя курьера.');
        await this.next(identityId, chatId, session, 'courierPhone', { courierName: text },
          'Введите телефон курьера.');
        return null;
      }
      if (session.step === 'courierPhone') {
        const parsed = deliverySchema.safeParse({ provider: 'OTHER', courierName: payload.courierName,
          courierPhone: text, price: 100 });
        if (!parsed.success) return this.retry(identityId, chatId, session, 'Введите корректный телефон курьера.');
        await this.next(identityId, chatId, session, 'price',
          { ...payload, courierPhone: parsed.data.courierPhone },
          'Введите цену доставки в рублях, например 350,00.');
        return null;
      }
      if (session.step === 'price') {
        const price = rublesToKopecks(text);
        if (!price) return this.retry(identityId, chatId, session, 'Введите положительную цену в рублях.');
        await this.next(identityId, chatId, session, 'trackingUrl', { ...payload, price },
          'Ссылка отслеживания (HTTP/HTTPS) или - чтобы пропустить.');
        return null;
      }
      if (session.step === 'trackingUrl') {
        const data = { ...payload, ...(text === '-' ? {} : { trackingUrl: text }) };
        const parsed = deliverySchema.safeParse({ provider: 'OTHER', ...data });
        if (!parsed.success) return this.retry(identityId, chatId, session, 'Введите корректную ссылку или -.');
        await this.next(identityId, chatId, session, 'externalOrderId', data,
          'Внешний номер доставки или - чтобы пропустить.');
        return null;
      }
      if (session.step === 'externalOrderId') {
        if (text !== '-' && (!text || text.length > 100))
          return this.retry(identityId, chatId, session, 'Введите номер до 100 символов или -.');
        const data = { ...payload, ...(text === '-' ? {} : { externalOrderId: text }) };
        await this.confirm(identityId, chatId, session, data,
          'Оформить доставку OTHER?\nКурьер: ' + clean(data.courierName, 100) +
          '\nЦена: ' + money(data.price), 'ds');
        return null;
      }
    }
    throw new Error('Unknown flow');
  }

  private async retry(identityId: number, chatId: number, session: StaffTelegramSession,
    prompt: string): Promise<null> {
    await this.next(identityId, chatId, session, session.step, payloadSchema.parse(session.payload), prompt);
    return null;
  }

  private async next(identityId: number, chatId: number, session: StaffTelegramSession,
    step: string, payload: FlowPayload, prompt: string): Promise<void> {
    const promptMessageId = await this.telegram.promptStaff(chatId, prompt + '\n/cancel — отменить ввод');
    if (!promptMessageId) {
      await this.db.staffTelegramSession.deleteMany({ where: { identityId, step: 'BUSY' } });
      return;
    }
    await this.db.staffTelegramSession.updateMany({
      where: { identityId, step: 'BUSY', orderId: session.orderId,
        promptMessageId: session.promptMessageId },
      data: { step, payload, promptMessageId, expiresAt: new Date(Date.now() + 15 * 60_000) },
    });
  }

  private async confirm(identityId: number, chatId: number, session: StaffTelegramSession,
    payload: FlowPayload, prompt: string, action: 'xs' | 'ds' | 'zy'): Promise<void> {
    const confirmationCode = randomBytes(8).toString('hex');
    const saved = await this.db.staffTelegramSession.updateMany({
      where: { identityId, step: 'BUSY', orderId: session.orderId,
        promptMessageId: session.promptMessageId },
      data: { step: 'CONFIRM', payload, promptMessageId: null, confirmationCode,
        expiresAt: new Date(Date.now() + 15 * 60_000) },
    });
    if (saved.count !== 1) return;
    const keyboard = { inline_keyboard: [
      [{ text: '✅ Подтвердить', callback_data: staffConfirmData(session.orderId, action, confirmationCode) }],
      [{ text: '↩️ Назад к заказу', callback_data: staffData(session.orderId, 'zb') }],
    ] };
    if (session.dashboardMessageId)
      await this.telegram.editStaff(chatId, session.dashboardMessageId, prompt, keyboard);
    else await this.telegram.sendStaff(chatId, prompt, keyboard);
  }

  async finish(identityId: number, actor: StaffActor, orderId: number,
    action: 'CANCEL' | 'EXTRA' | 'DELIVERY', confirmationCode?: string): Promise<boolean> {
    const session = await this.db.staffTelegramSession.findUnique({ where: { identityId } });
    if (!session || session.action !== action || session.step !== 'CONFIRM' ||
      session.orderId !== orderId || !confirmationCode || session.confirmationCode !== confirmationCode ||
      session.expiresAt <= new Date()) return false;
    const payload = payloadSchema.safeParse(session.payload);
    if (!payload.success) return false;
    // Only one callback wins; a repeated Telegram update cannot repeat an extra or cancellation.
    const claimed = await this.db.staffTelegramSession.deleteMany({
      where: { identityId, action, step: 'CONFIRM', orderId, confirmationCode,
        updatedAt: session.updatedAt,
        expiresAt: { gt: new Date() } },
    });
    if (claimed.count !== 1) return false;
    const data = payload.data;
    if (action === 'CANCEL') {
      if (!data.reason) return false;
      await this.staff.cancel(orderId, actor.userId, actor.role, data.reason, actor);
    } else if (action === 'EXTRA') {
      const input = extraSchema.safeParse({ title: data.title, quantity: data.quantity,
        unitPrice: data.unitPrice, comment: data.comment });
      if (!input.success) return false;
      await this.staff.extra(orderId, actor.userId, input.data, data.extraId, data.version, actor);
    } else {
      const input = deliverySchema.safeParse({ provider: 'OTHER', courierName: data.courierName,
        courierPhone: data.courierPhone, price: data.price, trackingUrl: data.trackingUrl,
        externalOrderId: data.externalOrderId });
      if (!input.success) return false;
      await this.staff.delivery(orderId, input.data, actor);
    }
    return true;
  }
}
