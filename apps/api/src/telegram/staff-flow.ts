import { HttpException } from '@nestjs/common';
import { z } from 'zod';
import { clean, money } from './staff-bot.js';

export type Flow = 'ITEM' | 'EXTRA' | 'DELIVERY' | 'CANCEL';
export const flowPayload = z.object({
  title: z.string().max(120).optional(), quantity: z.number().int().optional(),
  unitPrice: z.number().int().optional(), comment: z.string().max(1000).optional(),
  extraId: z.number().int().positive().optional(), version: z.number().int().positive().optional(),
  courierName: z.string().max(100).optional(), courierPhone: z.string().max(30).optional(),
  price: z.number().int().optional(), trackingUrl: z.string().max(500).optional(),
  externalOrderId: z.string().max(100).optional(), reason: z.string().max(1000).optional(),
}).strict();
export type FlowPayload = z.infer<typeof flowPayload>;

// Reconstruct prompts from durable action/step/payload; never store prompt text.
export function flowPrompt(action: string, step: string, data: FlowPayload, orderId: number,
  unit?: string): string {
  if (step === 'CONFIRM') {
    if (action === 'EXTRA') return 'Сохранить доп. позицию?\n' + clean(data.title, 120) +
      ' · ' + data.quantity + ' × ' + money(data.unitPrice);
    if (action === 'CANCEL') return 'Отменить заказ #' + orderId + '?\nПричина: ' + clean(data.reason, 500);
    if (action === 'DELIVERY') return 'Оформить доставку OTHER?\nКурьер: ' +
      clean(data.courierName, 100) + '\nЦена: ' + money(data.price);
  }
  if (action === 'ITEM' && step === 'qty') return unit === 'GRAM'
    ? 'Введите фактический вес целым числом граммов.'
    : 'Введите фактическое количество целым числом.';
  if (action === 'CANCEL' && step === 'reason') return 'Причина отмены (1–1000 символов).';
  const prompts: Record<string, Record<string, string>> = {
    EXTRA: {
      title: 'Название дополнительной позиции или услуги (до 120 символов).',
      quantity: 'Введите количество целым числом (1–10000).',
      price: 'Введите цену за единицу в рублях, например 120,50.',
      comment: 'Комментарий (до 1000 символов) или - чтобы пропустить.',
    },
    DELIVERY: {
      courierName: 'Имя курьера (до 100 символов).', courierPhone: 'Введите телефон курьера.',
      price: 'Введите цену доставки в рублях, например 350,00.',
      trackingUrl: 'Ссылка отслеживания (HTTP/HTTPS) или - чтобы пропустить.',
      externalOrderId: 'Внешний номер доставки или - чтобы пропустить.',
    },
  };
  const prompt = prompts[action]?.[step];
  if (!prompt) throw new Error('Invalid stored staff flow');
  return prompt;
}

export const uncertainMutation = 'Результат действия не подтверждён. Проверьте заказ через /orders. Не повторяйте действие до проверки.';
export function knownFlowError(error: unknown): error is HttpException {
  return error instanceof HttpException && [400, 403, 404, 409].includes(error.getStatus());
}
export function flowError(error: HttpException): string {
  if (error.getStatus() === 403) return 'Нет доступа';
  // Only these domain-generated numeric limit messages are allowed through.
  // Never expose arbitrary HttpException messages, DB or provider details.
  if (error.getStatus() === 400 && /^Максимальная (?:цена услуги|сумма услуг) — [0-9]{1,10}(?:\.[0-9]{1,2})? ₽\.$/.test(error.message))
    return error.message + ' Данные сохранены. /resume — продолжить, /cancel — отменить.';
  return 'Заказ или данные изменились. Обновите заказ через /orders. /resume — продолжить ввод, /cancel — отменить.';
}
