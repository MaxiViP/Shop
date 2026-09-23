import { z } from 'zod';
import type { OrderStatus } from '../db/gen/client.js';

export const callbackIdSchema = z.object({ id: z.string().min(1).max(256) });

export function parseAction(data: string) {
  const match = /^order:([1-9]\d{0,9}):(confirm|assembly|refresh|cancel_request|cancel_confirm|cancel_back)$/.exec(data);
  if (!match || match[0] !== data || Number(match[1]) > 2147483647) return null;
  return { orderId: Number(match[1]), action: match[2]! };
}

type Button = { text: string; url: string } | { text: string; callback_data: string };
export type Keyboard = { inline_keyboard: Button[][] };

const labels: Record<OrderStatus, string> = {
  NEW: 'Новый', CONFIRMED: 'Подтверждён', ASSEMBLING: 'Собирается', READY: 'Готов',
  DELIVERING: 'Доставляется', COMPLETED: 'Завершён', CANCELED: 'Отменён',
};

export function orderKeyboard(id: number, status: OrderStatus, url?: string, callbacks = true): Keyboard {
  const rows: Button[][] = [];
  if (callbacks) {
    if (status === 'NEW') rows.push([{ text: '✅ Подтвердить', callback_data: 'order:' + id + ':confirm' }]);
    if (status === 'CONFIRMED') rows.push([{ text: 'Начать сборку', callback_data: 'order:' + id + ':assembly' }]);
    rows.push([{ text: 'Открыть в боте', callback_data: 's:' + id + ':o' }]);
    // Full seller actions are shown after the linked staff member opens the dashboard.
  }
  if (url) rows.push([{ text: 'Открыть заказ' + (callbacks && status !== 'NEW' ? ' - ' + labels[status] : ''), url }]);
  return { inline_keyboard: rows };
}
