import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { StaffTelegramSession } from '../db/gen/client.js';
import type { StaffActor } from '../staff/audit.js';
import { DbService } from '../db/db.service.js';
import { StaffService } from '../staff/staff.service.js';
import { deliverySchema } from '../staff/schema.js';
import { extraSchema } from '../staff/extra.js';
import { positiveQty, rublesToKopecks, staffConfirmData, staffData, type StaffMessage } from './staff-bot.js';
import { flowPayload, flowPrompt, flowError, knownFlowError, uncertainMutation,
  type Flow, type FlowPayload } from './staff-flow.js';
import { TelegramService } from './telegram.service.js';

const expires = () => new Date(Date.now() + 15 * 60_000);
const revision = () => randomBytes(8).toString('hex');
// confirmationCode also fences prompt attempts/step revisions; timestamps alone
// cannot distinguish concurrent updates within one millisecond.
const match = (session: StaffTelegramSession) => ({
  identityId: session.identityId, action: session.action, step: session.step,
  orderId: session.orderId, itemId: session.itemId, promptMessageId: session.promptMessageId,
  confirmationCode: session.confirmationCode, updatedAt: session.updatedAt,
});

@Injectable()
export class StaffBotFlowService {
  private readonly logger = new Logger(StaffBotFlowService.name);
  constructor(private readonly db: DbService, private readonly staff: StaffService,
    private readonly telegram: TelegramService) {}

  async cancel(identityId: number, orderId?: number): Promise<boolean> {
    const session = await this.db.staffTelegramSession.findUnique({ where: { identityId } });
    if (!session || (orderId && session.orderId !== orderId)) return true;
    // Never erase a possibly committed mutation and enable a blind replay.
    if (session.step === 'COMMITTING') return false;
    return (await this.db.staffTelegramSession.deleteMany({ where: match(session) })).count === 1;
  }

  async start(identityId: number, chatId: number, dashboardMessageId: number,
    orderId: number, itemId: number | null, action: Flow, step: string,
    payload: FlowPayload = {}): Promise<boolean> {
    const current = await this.db.staffTelegramSession.findUnique({ where: { identityId } });
    if (current?.step === 'COMMITTING') return false;
    const data = { identityId, orderId, itemId, action, step, promptMessageId: null,
      dashboardMessageId, confirmationCode: revision(), payload: flowPayload.parse(payload), expiresAt: expires() };
    const saved = current
      ? await this.db.staffTelegramSession.updateMany({ where: match(current), data })
      : await this.db.staffTelegramSession.createMany({ data, skipDuplicates: true });
    if (saved.count !== 1) return false;
    const session = await this.db.staffTelegramSession.findUnique({ where: { identityId } });
    return session?.confirmationCode === data.confirmationCode ? this.present(chatId, session) : false;
  }

  async resume(identityId: number, chatId: number): Promise<void> {
    const session = await this.db.staffTelegramSession.findUnique({ where: { identityId } });
    if (!session) {
      await this.telegram.sendStaff(chatId, 'Нет незавершённого ввода. Отправьте /orders.');
      return;
    }
    if (session.step === 'COMMITTING') {
      await this.telegram.sendStaff(chatId, uncertainMutation);
      return;
    }
    if (await this.expired(session, chatId)) return;
    // Invalidates both old ForceReply prompts and previous confirmation buttons.
    const current = await this.change(session, { promptMessageId: null });
    if (current) await this.present(chatId, current);
  }

  private async expired(session: StaffTelegramSession, chatId: number): Promise<boolean> {
    if (session.expiresAt > new Date()) return false;
    await this.db.staffTelegramSession.deleteMany({ where: match(session) });
    await this.telegram.sendStaff(chatId, 'Время ввода истекло. Откройте заказ заново через /orders.');
    return true;
  }

  async input(message: StaffMessage, identityId: number, actor: StaffActor):
    Promise<{ orderId: number; dashboardMessageId: number | null } | null> {
    const session = await this.db.staffTelegramSession.findUnique({ where: { identityId } });
    if (!session || session.step === 'COMMITTING' || session.step === 'CONFIRM') return null;
    if (await this.expired(session, message.chat.id)) return null;
    if (!session.promptMessageId || !message.reply_to_message ||
      message.reply_to_message.message_id !== session.promptMessageId) return null;
    try {
      return await this.processInput(message, actor, session);
    } catch (error) {
      // Also invalidate a stale ITEM reply rejected before the mutation claim.
      if (knownFlowError(error)) await this.change(session, { promptMessageId: null });
      else this.logger.error('Staff Telegram input failed');
      await this.telegram.sendStaff(message.chat.id, knownFlowError(error) ? flowError(error) :
        'Не удалось подтвердить результат. /resume — проверить ввод, /orders — проверить заказ.');
      return null;
    }
  }

  private async processInput(message: StaffMessage, actor: StaffActor,
    session: StaffTelegramSession): Promise<{ orderId: number; dashboardMessageId: number | null } | null> {
    const text = message.text?.trim() ?? '';
    const chatId = message.chat.id;
    const payload = flowPayload.parse(session.payload);
    if (session.action === 'ITEM' && session.step === 'qty' && session.itemId) {
      const actualQty = positiveQty(text);
      if (!actualQty) return this.retry(chatId, session, 'Введите положительное целое количество.');
      const order = await this.staff.get(session.orderId);
      const item = order.items.find(value => value.id === session.itemId);
      if (!item || order.status !== 'ASSEMBLING' || item.status !== 'PENDING')
        throw new ConflictException('STALE_ITEM');
      const committed = await this.commit(session, () => this.staff.item(session.orderId, item.id,
        { status: 'PICKED', actualQty }, actor.userId, actor));
      return committed ? { orderId: session.orderId, dashboardMessageId: session.dashboardMessageId } : null;
    }
    if (session.action === 'CANCEL' && session.step === 'reason') {
      if (!text || text.length > 1000)
        return this.retry(chatId, session, 'Укажите причину отмены (1–1000 символов).');
      await this.next(chatId, session, 'CONFIRM', { reason: text });
      return null;
    }
    if (session.action === 'EXTRA') {
      if (session.step === 'title') {
        if (!text || text.length > 120)
          return this.retry(chatId, session, 'Введите название (1–120 символов).');
        await this.next(chatId, session, 'quantity', { ...payload, title: text });
        return null;
      }
      if (session.step === 'quantity') {
        const quantity = positiveQty(text, 10_000);
        if (!quantity) return this.retry(chatId, session, 'Введите количество от 1 до 10000.');
        await this.next(chatId, session, 'price', { ...payload, quantity });
        return null;
      }
      if (session.step === 'price') {
        const unitPrice = rublesToKopecks(text);
        if (!unitPrice) return this.retry(chatId, session, 'Введите положительную цену в рублях.');
        await this.next(chatId, session, 'comment', { ...payload, unitPrice });
        return null;
      }
      if (session.step === 'comment') {
        if (text.length > 1000) return this.retry(chatId, session, 'Комментарий слишком длинный.');
        await this.next(chatId, session, 'CONFIRM', { ...payload, comment: text === '-' ? '' : text });
        return null;
      }
    }
    if (session.action === 'DELIVERY') {
      if (session.step === 'courierName') {
        if (!text || text.length > 100) return this.retry(chatId, session, 'Введите имя курьера.');
        await this.next(chatId, session, 'courierPhone', { courierName: text });
        return null;
      }
      if (session.step === 'courierPhone') {
        const parsed = deliverySchema.safeParse({ provider: 'OTHER', courierName: payload.courierName,
          courierPhone: text, price: 100 });
        if (!parsed.success) return this.retry(chatId, session, 'Введите корректный телефон курьера.');
        await this.next(chatId, session, 'price', { ...payload, courierPhone: parsed.data.courierPhone });
        return null;
      }
      if (session.step === 'price') {
        const price = rublesToKopecks(text);
        const parsed = deliverySchema.safeParse({ provider: 'OTHER', ...payload, price });
        if (!parsed.success || !price) return this.retry(chatId, session, 'Введите допустимую положительную цену доставки в рублях.');
        await this.next(chatId, session, 'trackingUrl', { ...payload, price });
        return null;
      }
      if (session.step === 'trackingUrl') {
        const data = { ...payload, ...(text === '-' ? {} : { trackingUrl: text }) };
        const parsed = deliverySchema.safeParse({ provider: 'OTHER', ...data });
        if (!parsed.success || text.length > 500) return this.retry(chatId, session, 'Введите корректную ссылку или -.');
        await this.next(chatId, session, 'externalOrderId', data);
        return null;
      }
      if (session.step === 'externalOrderId') {
        if (text !== '-' && (!text || text.length > 100))
          return this.retry(chatId, session, 'Введите номер до 100 символов или -.');
        await this.next(chatId, session, 'CONFIRM',
          { ...payload, ...(text === '-' ? {} : { externalOrderId: text }) });
        return null;
      }
    }
    throw new Error('Invalid stored staff flow');
  }

  private async retry(chatId: number, session: StaffTelegramSession, prompt: string): Promise<null> {
    const current = await this.change(session, { promptMessageId: null });
    if (current) await this.present(chatId, current, prompt);
    return null;
  }

  private async next(chatId: number, session: StaffTelegramSession, step: string, payload: FlowPayload): Promise<void> {
    // Persist the accepted input and next step before doing any Telegram I/O.
    const current = await this.change(session, { step, payload: flowPayload.parse(payload), promptMessageId: null });
    if (current) await this.present(chatId, current);
  }

  private async change(session: StaffTelegramSession,
    data: { step?: string; payload?: FlowPayload; promptMessageId?: number | null },
    requireFresh = true): Promise<StaffTelegramSession | null> {
    const values = { ...data, confirmationCode: revision(), expiresAt: expires() };
    const changed = await this.db.staffTelegramSession.updateMany({
      where: { ...match(session), ...(requireFresh ? { expiresAt: { gt: new Date() } } : {}) },
      data: values,
    });
    if (changed.count !== 1) return null;
    // Read the DB timestamp back rather than guessing @updatedAt precision.
    const current = await this.db.staffTelegramSession.findUnique({ where: { identityId: session.identityId } });
    return current?.confirmationCode === values.confirmationCode ? current : null;
  }

  private async present(chatId: number, session: StaffTelegramSession, retryPrompt?: string): Promise<boolean> {
    const data = flowPayload.parse(session.payload);
    let unit: string | undefined;
    if (session.action === 'ITEM') {
      const order = await this.staff.get(session.orderId);
      const item = order.items.find(value => value.id === session.itemId);
      if (!item || order.status !== 'ASSEMBLING' || item.status !== 'PENDING')
        throw new ConflictException('STALE_ITEM');
      unit = item.unit;
    }
    const prompt = retryPrompt ?? flowPrompt(session.action, session.step, data, session.orderId, unit);
    if (session.step === 'CONFIRM') {
      const action = session.action === 'EXTRA' ? 'xs' : session.action === 'DELIVERY' ? 'ds' : 'zy';
      if (!session.confirmationCode) return false;
      const keyboard = { inline_keyboard: [
        [{ text: '✅ Подтвердить', callback_data: staffConfirmData(session.orderId, action, session.confirmationCode) }],
        [{ text: '↩️ Назад к заказу', callback_data: staffData(session.orderId, 'zb') }],
      ] };
      if (session.dashboardMessageId)
        await this.telegram.editStaff(chatId, session.dashboardMessageId, prompt, keyboard);
      else await this.telegram.sendStaff(chatId, prompt, keyboard);
      return true;
    }
    const promptMessageId = await this.telegram.promptStaff(chatId, prompt +
      '\nОтветьте на это сообщение. /resume — повторить запрос, /cancel — отменить ввод.');
    // Unknown means unbound, never lost. Only an explicit /resume sends again.
    if (!promptMessageId) return false;
    return (await this.db.staffTelegramSession.updateMany({
      where: { ...match(session), expiresAt: { gt: new Date() } },
      data: { promptMessageId },
    })).count === 1;
  }

  private async commit(session: StaffTelegramSession, mutation: () => Promise<unknown>): Promise<boolean> {
    const claimed = await this.change(session, { step: 'COMMITTING', promptMessageId: null });
    if (!claimed) return false;
    try {
      await mutation();
    } catch (error) {
      // These exceptions originate inside StaffService's transaction (rolled back).
      // Its post-commit notification dispatcher already isolates provider failures.
      if (knownFlowError(error)) {
        await this.change(claimed, { step: session.step, promptMessageId: null }, false);
      } else {
        // A lost DB commit response/process failure is NOT evidence of rollback.
        // Keep COMMITTING for manual reconciliation; /resume must never replay it.
        this.logger.error('Staff Telegram mutation outcome unknown');
      }
      throw error;
    }
    try {
      await this.db.staffTelegramSession.deleteMany({ where: match(claimed) });
    } catch {
      // Business success remains success even if cleanup or dashboard delivery fails.
      this.logger.error('Staff Telegram flow cleanup failed');
    }
    return true;
  }

  async finish(identityId: number, actor: StaffActor, orderId: number,
    action: 'CANCEL' | 'EXTRA' | 'DELIVERY', confirmationCode?: string): Promise<boolean> {
    const session = await this.db.staffTelegramSession.findUnique({ where: { identityId } });
    if (!session || session.action !== action || session.step !== 'CONFIRM' ||
      session.orderId !== orderId || !confirmationCode || session.confirmationCode !== confirmationCode ||
      session.expiresAt <= new Date()) return false;
    const payload = flowPayload.safeParse(session.payload);
    if (!payload.success) throw new BadRequestException('INVALID_FLOW');
    const data = payload.data;
    if (action === 'CANCEL') {
      if (!data.reason) throw new BadRequestException('INVALID_FLOW');
      return this.commit(session, () => this.staff.cancel(orderId, actor.userId, actor.role, data.reason, actor));
    }
    if (action === 'EXTRA') {
      const input = extraSchema.safeParse({ title: data.title, quantity: data.quantity,
        unitPrice: data.unitPrice, comment: data.comment });
      if (!input.success) throw new BadRequestException('INVALID_FLOW');
      return this.commit(session, () => this.staff.extra(orderId, actor.userId,
        input.data, data.extraId, data.version, actor));
    }
    const input = deliverySchema.safeParse({ provider: 'OTHER', courierName: data.courierName,
      courierPhone: data.courierPhone, price: data.price, trackingUrl: data.trackingUrl,
      externalOrderId: data.externalOrderId });
    if (!input.success) throw new BadRequestException('INVALID_FLOW');
    return this.commit(session, () => this.staff.delivery(orderId, input.data, actor));
  }
}
