import { BadRequestException } from '@nestjs/common';
import type {
  CustomerTelegramSession,
  PaymentMethod,
} from '../db/gen/client.js';
import type { CartService } from '../cart/cart.service.js';
import { checkoutPayload, checkoutPrompts, checkoutStep } from './checkout.js';
import { shoppingData } from './shopping-callback.js';
import { customerView } from './customer-callback.js';
import {
  amount,
  quantity,
  short,
  date,
  webAppUrl,
  type CustomerOrder,
  type Screen,
  type Button,
} from './customer-view.js';
const methodNames = { SBP: 'СБП', CARD_TRANSFER: 'На карту', QR: 'QR' };
export function checkoutScreen(
  session: CustomerTelegramSession,
  basket: Awaited<ReturnType<CartService['get']>> | null,
): Screen | { prompt: string } {
  const data = checkoutPayload.parse(session.payload);
  const step = checkoutStep.parse(session.step);
  const choose = (text: string, choice: string): Button => ({
    text,
    callback_data: shoppingData('f', session.id, choice),
  });
  let screen: Screen;
  if (step === 'TYPE')
    screen = {
      text: 'Как получить заказ?',
      keyboard: {
        inline_keyboard: [
          [choose('Самовывоз', 'pickup'), choose('Доставка', 'delivery')],
          [choose('Отмена', 'cancel')],
        ],
      },
    };
  else if (step === 'ADDRESS')
    screen = {
      text: 'Адрес доставки',
      keyboard: {
        inline_keyboard: [
          ...(data.addressId
            ? [[choose('Использовать сохранённый адрес', 'saved')]]
            : []),
          [choose('Ввести новый адрес', 'new')],
          [choose('Отмена', 'cancel')],
        ],
      },
    };
  else if (step === 'CONFIRM') {
    if (!basket) throw new BadRequestException();
    const same =
      basket.revision === data.cartRevision && basket.token === data.quoteToken;
    const lines = [
      data.type === 'PICKUP' ? 'Самовывоз' : 'Доставка',
      'Имя: ' + short(data.customerName!, 100),
      'Телефон: ' + short(data.customerPhone!, 30),
      ...(data.address
        ? [short(Object.values(data.address).filter(Boolean).join(', '), 650)]
        : []),
      data.deliveryAt
        ? 'Время: ' + date(new Date(data.deliveryAt))
        : 'Как можно скорее',
      ...basket.items
        .slice(0, 5)
        .map(
          (i) =>
            short(i.product?.name ?? 'Недоступный товар', 70) +
            ' · ' +
            (i.product ? quantity(i.qty, i.product.unit) : '') +
            ' · ≈ ' +
            amount(i.lineTotal),
        ),
      ...(basket.items.length > 5
        ? ['…и ещё ' + (basket.items.length - 5) + ' позиций']
        : []),
      'Предварительно: ≈ ' + amount(basket.subtotal),
      ...(data.type === 'DELIVERY'
        ? ['Доставка рассчитывается и оплачивается отдельно.']
        : []),
      'Окончательная стоимость товаров — после сборки.',
      ...(!same
        ? [
            '⚠️ Корзина или цены изменились. /resume обновит цены; если состав изменён — начните заново через /cart.',
          ]
        : []),
    ];
    screen = {
      text: lines.join('\n'),
      keyboard: {
        inline_keyboard: [
          ...(same && basket.valid
            ? [[choose('✅ Создать заказ', 'confirm')]]
            : []),
          [choose('Изменить данные', 'edit')],
          [
            { text: '← Корзина', callback_data: 'cart' },
            choose('Отмена', 'cancel'),
          ],
        ],
      },
    };
  } else {
    if (session.promptMessageId)
      return {
        text: 'Ответьте на последнее приглашение. /resume — показать его заново.',
        keyboard: {
          inline_keyboard: [
            [
              { text: 'Продолжить ввод', callback_data: 'resume' },
              choose('Отмена', 'cancel'),
            ],
          ],
        },
      };
    const prompt = checkoutPrompts[step];
    if (!prompt) throw new BadRequestException();
    return {
      prompt:
        prompt +
        '\nОтветьте именно на это сообщение. /resume — восстановить, /cancel — отмена.',
    };
  }
  return screen;
}

export function paymentScreen(
  order: CustomerOrder,
  method: PaymentMethod,
): Screen {
  const publicId = order.publicId;
  const payment = order.payment,
    details = order.paymentDetails;
  const buttons: Button[][] = [];
  const lines = ['💳 Оплата заказа №' + order.id];
  if (!payment || !details || payment.status === 'CANCELED')
    lines.push('Оплата пока недоступна.');
  else {
    lines.push('К оплате за товары: ' + amount(payment.amount));
    if (order.type === 'DELIVERY')
      lines.push('Доставка оплачивается отдельно.');
    if (payment.status === 'REPORTED')
      lines.push(
        '✅ Вы сообщили об оплате.',
        'Продавец проверит поступление денег. Повторно переводить деньги не нужно.',
      );
    else if (payment.status === 'PAID') lines.push('✅ Оплата получена.');
    else {
      const selected = details.methods.includes(method)
        ? method
        : (details.methods[0] as typeof method | undefined);
      if (!selected)
        lines.push('Реквизиты пока не настроены. Напишите продавцу.');
      else {
        lines.push('Способ: ' + methodNames[selected]);
        if (details.recipientName)
          lines.push('Получатель: ' + short(details.recipientName, 120));
        if (details.bankName)
          lines.push('Банк: ' + short(details.bankName, 120));
        if (selected === 'SBP' && details.phone)
          lines.push('Телефон: ' + short(details.phone, 80));
        if (selected === 'CARD_TRANSFER' && details.cardNumber)
          lines.push('Карта: ' + short(details.cardNumber, 80));
        if (selected === 'QR' || (selected === 'SBP' && !details.phone)) {
          const url = webAppUrl('/order/' + publicId);
          if (url) buttons.push([{ text: 'Открыть оплату на сайте', web_app: { url } }]);
        }
        for (const m of ['SBP', 'CARD_TRANSFER', 'QR'] as const)
          if (details.methods.includes(m))
            buttons.push([
              {
                text: methodNames[m],
                callback_data: shoppingData('p', publicId, m),
              },
            ]);
        if (order.status === 'READY' && payment.amount === order.finalSubtotal)
          buttons.push([
            {
              text: '✅ Я оплатил · ' + methodNames[selected],
              callback_data: shoppingData('r', publicId, selected),
            },
          ]);
        lines.push(
          'После перевода сообщите об оплате кнопкой ниже. Получение денег подтверждает продавец.',
        );
      }
    }
  }
  buttons.push([
    { text: '← К заказу', callback_data: customerView('o', publicId) },
  ]);
  return {
    text: lines.join('\n'),
    keyboard: { inline_keyboard: buttons },
  };
}
