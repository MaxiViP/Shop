import { HttpException, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { DbService } from '../db/db.service.js';
import type { OrderStatus } from '../db/gen/client.js';
import { StaffService } from '../staff/staff.service.js';
import { TelegramService } from './telegram.service.js';
import { callbackIdSchema, callbackSchema, parseAction, updateSchema } from './callback.js';

@Injectable()
export class TelegramUpdateService {
  private readonly logger = new Logger(TelegramUpdateService.name);
  constructor(
    private readonly db: DbService,
    private readonly staff: StaffService,
    private readonly telegram: TelegramService,
  ) {}

  async handle(body: unknown): Promise<void> {
    const update = updateSchema.safeParse(body);
    if (!update.success || update.data.callback_query === undefined) return;
    const query = update.data.callback_query;
    const ack = callbackIdSchema.safeParse(query);
    if (!ack.success) return; // There is no usable callback ID to acknowledge.
    const parsed = callbackSchema.safeParse(query);
    if (!parsed.success) {
      await this.telegram.answerCallbackQuery(ack.data.id, 'Некорректная кнопка');
      return;
    }
    const callback = parsed.data;
    if (!this.telegram.canManage(callback)) {
      await this.telegram.answerCallbackQuery(callback.id, 'Нет доступа');
      return;
    }
    const command = parseAction(callback.data);
    if (!command) {
      await this.telegram.answerCallbackQuery(callback.id, 'Некорректная кнопка');
      return;
    }

    const { orderId, action } = command;
    let answer = 'Не удалось выполнить действие';
    let status: OrderStatus | undefined;
    try {
      const order = await this.db.order.findUnique({ where: { id: orderId }, select: { status: true } });
      if (!order) {
        answer = 'Заказ недоступен';
        return;
      }
      status = order.status;
      switch (action) {
        case 'confirm':
          if (status !== 'NEW') { answer = 'Статус заказа уже изменился'; break; }
          await this.staff.confirm(orderId);
          answer = 'Заказ подтверждён';
          break;
        case 'assembly':
          if (status !== 'CONFIRMED') { answer = 'Статус заказа уже изменился'; break; }
          await this.staff.startAssembly(orderId);
          answer = 'Сборка начата';
          break;
        case 'refresh':
          answer = 'Статус обновлён';
          break;
        case 'cancel_request':
        case 'cancel_confirm':
        case 'cancel_back':
          answer = 'Отмена доступна на сайте';
          break;
      }
      // Re-read after a transition: the database, not the old Telegram message, is authoritative.
      status = (await this.db.order.findUnique({ where: { id: orderId }, select: { status: true } }))?.status;
    } catch (error) {
      if (error instanceof HttpException && [400, 404, 409].includes(error.getStatus())) {
        answer = error.getStatus() === 404 ? 'Заказ недоступен' : 'Статус заказа уже изменился';
        // A concurrent transition can invalidate the button between the read and row lock.
        status = undefined;
        try {
          status = (await this.db.order.findUnique({ where: { id: orderId }, select: { status: true } }))?.status;
        } catch {
          this.logger.warn('Telegram status refresh failed');
        }
      } else {
        status = undefined;
        this.logger.error('Telegram callback processing failed');
        // Keep unexpected failures visible as a sanitized 500; do not expose the original error.
        throw new InternalServerErrorException('Telegram update failed');
      }
    } finally {
      await Promise.all([
        this.telegram.answerCallbackQuery(callback.id, answer),
        status
          ? this.telegram.editOrderKeyboard(callback.message.chat.id, callback.message.message_id, orderId, status)
          : Promise.resolve(),
      ]);
    }
  }
}
