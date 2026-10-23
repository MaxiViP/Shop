import { BadRequestException } from '@nestjs/common';
import type {
  CustomerTelegramSession,
  PaymentMethod,
} from '../db/gen/client.js';
import type { CartService } from '../cart/cart.service.js';
import type { OrderService } from '../order/order.service.js';
import { checkoutPayload, checkoutPrompts, checkoutStep } from './checkout.js';
import { shoppingData } from './shopping-callback.js';
import { customerView } from './customer-callback.js';
import {
  amount,
  addressLines,
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
  offer?: Awaited<ReturnType<OrderService['offer']>> | null,
): Screen | { prompt: string } {
  const data = checkoutPayload.parse(session.payload);
  const step = checkoutStep.parse(session.step);
  const choose = (text: string, choice: string, style?: Button['style']): Button => ({
    text,
    callback_data: shoppingData('f', session.id, choice),
    ...(style ? { style } : {}),
  });
  let screen: Screen;
  if (step === 'TYPE')
    screen = {
      text: 'Как получить заказ?',
      keyboard: {
        inline_keyboard: [
          [choose('Самовывоз', 'pickup'), choose('Доставка', 'delivery')],
          ...(data.type && data.customerName && data.customerPhone && data.fulfillmentMode &&
            (data.type === 'PICKUP' || data.address) ? [[choose('Оставить без изменений', 'edit_done', 'primary')]] : []),
          [choose('Отмена', 'cancel', 'danger')],
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
          ...(data.address && data.fulfillmentMode ? [[choose('Оставить этот адрес', 'edit_done', 'primary')]] : []),
          [choose('Отмена', 'cancel', 'danger')],
        ],
      },
    };
  else if (step === 'CONFIRM') {
    if (!basket) throw new BadRequestException();
    const same =
      basket.revision === data.cartRevision && basket.token === data.quoteToken;
    const lines = [
      'Проверьте заказ',
      data.type === 'PICKUP' ? 'Самовывоз' : 'Доставка',
      'Имя: ' + short(data.customerName!, 100),
      'Телефон: ' + short(data.customerPhone!, 30),
      ...(data.type === 'DELIVERY' && data.address
        ? addressLines(data.address)
        : []),
      data.scheduledFor
        ? 'Подготовить к: ' + date(new Date(data.scheduledFor))
        : 'Как можно скорее',
      ...basket.items
        .slice(0, 5)
        .map(
          (i) =>
            short(i.product?.name ?? 'Недоступный товар', 70) +
            ' · ' +
            (i.product ? quantity(i.qty, i.quantityUnit ?? i.product.unit) : '') +
            ' · ' +
            (i.lineTotal === null ? 'после взвешивания' : '≈ ' + amount(i.lineTotal)),
        ),
      ...(basket.items.length > 5
        ? ['…и ещё ' + (basket.items.length - 5) + ' позиций']
        : []),
      'Товары предварительно: ' + (basket.subtotal === null ? 'после взвешивания' : '≈ ' + amount(basket.subtotal)),
      ...(basket.promo ? ['Промокод: ' + short(basket.promo.code, 32) + ' · скидка ' + amount(basket.promo.discount),
        'За товары после скидки: ' + amount(basket.goodsTotal), ...(basket.promo.reason ? [basket.promo.reason] : [])] : []),
      ...(data.type === 'DELIVERY'
        ? [basket.delivery.eligible ? 'Бесплатная доставка.' : 'Доставка рассчитывается и оплачивается отдельно.']
        : []),
      ...(basket.promo ? ['Итого предварительно: ' + amount(data.type === 'PICKUP' || basket.delivery.eligible ? basket.goodsTotal : null)] : []),
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
          ...(same && basket.valid && (!basket.promo || basket.promo.eligible)
            ? [[choose('✅ Создать заказ', 'confirm', 'success')]]
            : []),
          [choose('✏️ Имя получателя', 'edit_name'), choose('✏️ Телефон', 'edit_phone')],
          [choose('Получение', 'edit_type'), choose('Время подготовки', 'edit_time')],
          ...(data.type === 'DELIVERY' ? [[choose('Адрес доставки', 'edit_address'), choose('Комментарий к доставке', 'edit_comment')]] : []),
          [
            { text: '← Корзина', callback_data: 'cart' },
            choose('Отмена', 'cancel', 'danger'),
          ],
        ],
      },
    };
  } else {
    if (session.promptMessageId)
      return {
        text: 'Нажмите «Ответить» на последнем приглашении. /resume — показать его заново.',
        keyboard: {
          inline_keyboard: [
            [
              { text: 'Продолжить ввод', callback_data: 'resume' },
              choose('Отмена', 'cancel'),
            ],
          ],
        },
      };
    const prompt = step === 'TIME' && offer?.preorderRequired
      ? 'Сейчас доступен предзаказ. Укажите свободное время подготовки: ДД.ММ.ГГГГ ЧЧ:ММ (Москва).'
      : checkoutPrompts[step];
    if (!prompt) throw new BadRequestException();
    const timing = offer?.preorderRequired
      ? 'Рынок закрыт или сегодня уже не успеваем собрать заказ. Предзаказы принимаются.'
      : offer && offer.queueLength > 0
        ? `Примерно ${offer.position}-й в очереди, начало через ${offer.wait?.min}–${offer.wait?.max} мин.`
        : 'Можно оформить заказ сейчас.';
    return {
      prompt:
        prompt + (step === 'COMMENT' && data.address?.comment ? '\nСейчас: ' + short(data.address.comment, 300) + '\nНовый ответ заменит только комментарий. «-» — убрать его.' : '') +
        (step === 'NAME' && data.customerName ? '\nСейчас: ' + short(data.customerName, 100) : '') +
        (step === 'PHONE' && data.customerPhone ? '\nСейчас: ' + short(data.customerPhone, 30) : '') +
        (step === 'TIME' && offer
          ? '\n' + timing + (offer.slots.length && (offer.showScheduledOffer || offer.preorderRequired)
            ? ` Можно выбрать время: ДД.ММ.ГГГГ ЧЧ:ММ (Москва). Ближайшие свободные слоты: ${offer.slots.slice(0, 3).map(slot => date(new Date(slot.at))).join(', ')}. Доступность проверим при оформлении.`
            : offer.preorderRequired ? ' Свободных интервалов пока нет. Попробуйте позже.' : '')
          : '') +
        '\nНажмите «Ответить» на этом сообщении и введите ответ. /resume — восстановить, /cancel — отмена.',
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
  if (!payment || !details || payment.status === 'CANCELED' || order.status === 'CANCELED')
    lines.push('Оплата пока недоступна.');
  else {
    lines.push('К оплате за товары: ' + amount(payment.amount));
    if (order.type === 'DELIVERY')
      lines.push(order.deliveryPrice === 0 ? 'Доставка: бесплатно.' : order.deliveryPrice != null
        ? 'Доставка: ' + amount(order.deliveryPrice) + ' · оплачивается отдельно.'
        : 'Стоимость доставки уточняется и оплачивается отдельно.');
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
                text: (m === selected ? '✓ ' : '') + methodNames[m],
                callback_data: shoppingData('p', publicId, m),
              },
            ]);
        lines.push(
          'После перевода ничего подтверждать не нужно. Продавец проверит поступление денег.',
        );
      }
    }
  }
  buttons.push([{ text: '🔄 Обновить оплату', callback_data: shoppingData('p', publicId, method) }]);
  buttons.push([{ text: '💬 Вопрос по оплате', callback_data: customerView('w', publicId) }]);
  buttons.push([
    { text: '← К заказу', callback_data: customerView('o', publicId) },
  ]);
  return {
    text: lines.join('\n'),
    keyboard: { inline_keyboard: buttons },
  };
}

export function clearCartScreen(basket: Awaited<ReturnType<CartService['get']>>): Screen {
  return {
    text: 'Очистить корзину?\n\n' + 'В корзине: ' + basket.items.length + ' поз.\n' +
      'Товары предварительно: ' + (basket.goodsTotal === null ? 'после взвешивания' : '≈ ' + amount(basket.goodsTotal)) +
      '\n\nБудут удалены все товары из этой корзины. Уже оформленные заказы сохранятся.',
    keyboard: { inline_keyboard: [
      [{ text: 'Оставить товары · вернуться в корзину', callback_data: 'cart', style: 'primary' }],
      [{ text: 'Да, очистить корзину', callback_data: shoppingData('y', basket.revision), style: 'danger' }],
    ] },
  };
}

export function shoppingHelpScreen(): Screen {
  const delivery = webAppUrl('/delivery'), about = webAppUrl('/how-it-works');
  return {
    text: 'ℹ️ Покупки в KorzinaMarket\n\n' +
      '🛍 Выберите товары в каталоге. Кнопки + и − сразу меняют корзину, новое количество видно в той же карточке. Перед созданием заказа проверьте состав, контакты, способ и время получения.\n\n' +
      '⚖️ Весовые товары: сумма предварительная. Целые экземпляры выбираются в штуках, окончательная стоимость зависит от фактического веса. Если нужно ваше решение по весу или замене, появится отдельный вопрос с ценой и разницей.\n\n' +
      '💳 Оплата: после сборки откройте заказ и реквизиты. Переводите указанную сумму за товары; продавец проверит поступление. Повторно переводить деньги при проверке не нужно. Условия доставки видны в заказе.\n\n' +
      '💬 Общение: выберите заказ → «Написать продавцу», затем ответьте на приглашение Telegram. Сообщения привязаны к выбранному заказу; фото и отметки открываются на сайте.\n\n' +
      '📱 Для заказов нужен ваш контакт Telegram. Каталог и помощь доступны до подтверждения номера.\n\n' +
      '/catalog — каталог · /cart — корзина\n/orders — заказы · /current — текущий заказ\n/messages — вопросы и непрочитанное\n/resume — восстановить ввод\n/cancel — отменить только текущий ввод; заказ и товары сохраняются.',
    keyboard: { inline_keyboard: [
      [{ text: '🛍 Каталог', callback_data: 'catalog' }, { text: '🛒 Корзина', callback_data: 'cart' }],
      [{ text: '❗ Вопросы и сообщения', callback_data: 'attention' }],
      ...((delivery || about) ? [[
        ...(delivery ? [{ text: 'Доставка и самовывоз', web_app: { url: delivery } }] : []),
        ...(about ? [{ text: 'О сервисе', web_app: { url: about } }] : []),
      ]] : []),
      [{ text: 'Меню', callback_data: 'menu' }],
    ] },
  };
}
