import { HttpException } from '@nestjs/common';
// Never forward arbitrary Error.message/provider/DB text to Telegram.
const safe = new Set([
  'Самовывоз временно недоступен.',
  'Доставка временно недоступна.',
  'Проверьте данные заказа и время получения.',
  'Проверьте формат ответа. Для пропуска необязательного поля — «-».',
  'Количество не соответствует шагу или пределу товара',
  'В корзине не больше 50 товаров',
  'Способ оплаты не настроен',
  'Некорректный номер телефона',
]);
export function customerError(
  error: unknown,
  shopping: boolean,
): string | undefined {
  if (!(error instanceof HttpException)) return undefined;
  const status = error.getStatus();
  if (shopping && status === 409)
    return 'Данные уже изменились. /resume — продолжить ввод; /cart — корзина; /current — заказ.';
  if (shopping && status === 404)
    return 'Товар или заказ недоступен. Откройте /catalog или /orders.';
  if (status !== 400) return undefined;
  const body = error.getResponse();
  const text =
    typeof body === 'string'
      ? body
      : typeof body === 'object' && body !== null && 'message' in body
        ? body.message
        : null;
  if (typeof text !== 'string') return undefined;
  if (
    safe.has(text) ||
    /^Минимальная сумма товаров для доставки — [0-9]+(?:\.[0-9]{1,2})? ₽\.$/.test(
      text,
    )
  )
    return text;
  return shopping
    ? 'Проверьте данные заказа. /resume — продолжить; /cart — корзина.'
    : undefined;
}
