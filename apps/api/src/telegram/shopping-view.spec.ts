import { randomUUID } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import type { CustomerTelegramSession } from '../db/gen/client.js';
import type { CartService } from '../cart/cart.service.js';
import { checkoutScreen, paymentScreen, clearCartScreen, shoppingHelpScreen } from './shopping-view.js';
import type { CustomerOrder } from './customer-view.js';
import { shoppingAction } from './shopping-callback.js';
import { customerError } from './customer-error.js';
const publicId = '12345678-1234-4234-8234-123456789abc';
function order(status = 'AWAITING') {
  return {
    id: 7,
    publicId,
    status: 'READY',
    type: 'DELIVERY',
    finalSubtotal: 12345,
    payment: { status, amount: 12345 },
    paymentDetails: {
      methods: ['SBP', 'CARD_TRANSFER', 'QR'],
      phone: 'fixture phone',
      cardNumber: 'fixture card',
      bankName: 'fixture bank',
      recipientName: 'fixture name',
      qrImageUrl: 'https://media.example/qr.png',
      sbpLink: null,
    },
  } as unknown as CustomerOrder;
}
const callbacks = (screen: ReturnType<typeof paymentScreen>) =>
  screen.keyboard.inline_keyboard
    .flat()
    .flatMap((b) => ('callback_data' in b ? [b.callback_data] : []));
describe('customer payment display', () => {
  beforeEach(() => vi.stubEnv('ORDER_SITE_URL', 'https://shop.example'));
  afterEach(() => vi.unstubAllEnvs());
  it.each(['SBP', 'CARD_TRANSFER', 'QR'] as const)(
    'shows configured %s without requiring a payment report',
    (method) => {
      const screen = paymentScreen(order(), method);
      expect(screen.text).toContain('Оплата заказа №7');
      expect(screen.text).toContain('123,45');
      expect(callbacks(screen).some(value => shoppingAction(value)?.kind === 'paid')).toBe(false);
      expect(screen.text).toContain('После перевода ничего подтверждать не нужно');
      expect(screen.keyboard.inline_keyboard.flat().some(button => button.text.includes('Я оплатил'))).toBe(false);
      expect(callbacks(screen).join()).not.toContain('fixture');
      expect(
        screen.keyboard.inline_keyboard.flat().filter((b) => 'url' in b),
      ).not.toContainEqual(
        expect.objectContaining({ url: 'https://media.example/qr.png' }),
      );
    },
  );
  it.each(['REPORTED', 'PAID', 'CANCELED'])(
    'never offers a customer PAID mutation for %s',
    (status) => {
      const screen = paymentScreen(order(status), 'SBP');
      expect(
        callbacks(screen).some((v) => shoppingAction(v)?.kind === 'paid'),
      ).toBe(false);
      if (status === 'REPORTED')
        expect(screen.text).toContain('Повторно переводить');
    },
  );
  it('keeps reports hidden for changed totals and handles unconfigured payment methods', () => {
    const changed = order();
    changed.finalSubtotal = 999;
    expect(
      callbacks(paymentScreen(changed, 'SBP')).some(
        (v) => shoppingAction(v)?.kind === 'paid',
      ),
    ).toBe(false);
    changed.paymentDetails!.methods = [];
    expect(paymentScreen(changed, 'SBP').text).toContain(
      'Реквизиты пока не настроены',
    );
  });
});
describe('checkout presentation', () => {
  const session = (step: string) =>
    ({
      id: randomUUID(),
      identityId: 1,
      orderId: null,
      action: 'CHECKOUT',
      step,
      promptMessageId: null,
      payload: { cartRevision: randomUUID(), quoteToken: 'a'.repeat(64) },
      expiresAt: new Date(Date.now() + 60000),
      createdAt: new Date(),
      updatedAt: new Date(),
    }) satisfies CustomerTelegramSession;
  it.each([
    'NAME',
    'PHONE',
    'CITY',
    'STREET',
    'HOUSE',
    'FLAT',
    'ENTRANCE',
    'FLOOR',
    'INTERCOM',
    'COMMENT',
    'TIME',
  ])('can reconstruct %s prompt without storing text', (step) => {
    const screen = checkoutScreen(session(step), null);
    expect('prompt' in screen).toBe(true);
    if ('prompt' in screen) {
      expect(screen.prompt).toContain('/resume');
      expect(screen.prompt).not.toContain('???');
    }
  });
  it('offers a preparation time in Telegram only when load is high and a slot is free', () => {
    const normal = checkoutScreen(session('TIME'), null);
    expect('prompt' in normal && normal.prompt).not.toContain('Можно выбрать время');
    const peak = checkoutScreen(session('TIME'), null, {
      queueLength: 4, position: 5, wait: { min: 30, max: 45 },
      estimatedAssemblyMinutes: 25, showScheduledOffer: true, peakModeActive: true,
      assemblyConcurrency: 1, preorderRequired: false, preparationStartsAt: null,
      market: { isOpen: true, timezone: 'Europe/Moscow', today: '2026-10-10', openTime: '09:00', closeTime: '21:00', nextOpenAt: null },
      slots: [{ at: '2099-01-01T12:00:00.000Z', reserved: 0, capacity: 1 }],
    });
    expect('prompt' in peak && peak.prompt).toContain('Можно выбрать время');
    expect('prompt' in peak && peak.prompt).toContain('30–45 мин');
  });
  it('cancel buttons carry the exact current revision; IDs never appear in visible text', () => {
    const s = session('TYPE'),
      screen = checkoutScreen(s, null);
    expect('keyboard' in screen).toBe(true);
    if ('keyboard' in screen) {
      expect(callbacks(screen).map(shoppingAction)).toContainEqual({
        kind: 'flow',
        revision: s.id,
        choice: 'cancel',
      });
      expect(screen.text).not.toContain(s.id);
    }
  });
  it('shows a complete checkout summary with explicit creation and separate field edits', () => {
    const s = session('CONFIRM');
    s.payload = { ...s.payload as object, type: 'DELIVERY', customerName: 'Покупатель', customerPhone: '+79990000007',
      address: { city: 'Москва', street: 'Тестовая', house: '1' }, fulfillmentMode: 'ASAP' };
    const basket = { revision: (s.payload as { cartRevision: string }).cartRevision, token: 'a'.repeat(64),
      valid: true, subtotal: 32000, goodsTotal: 32000, promo: null, delivery: { eligible: false },
      items: [{ qty: 1000, product: { name: 'Помидоры', unit: 'GRAM' }, lineTotal: 32000 }] } as unknown as Awaited<ReturnType<CartService['get']>>;
    const screen = checkoutScreen(s, basket);
    if (!('keyboard' in screen)) throw new Error('Expected confirmation');
    for (const value of ['Проверьте заказ', 'Москва', '+79990000007', '1 кг', '320 ₽', 'Как можно скорее'])
      expect(screen.text).toContain(value);
    const buttons = screen.keyboard.inline_keyboard.flat();
    expect(buttons.find(button => button.text === '✅ Создать заказ')).toMatchObject({ style: 'success' });
    expect(buttons.map(button => 'callback_data' in button ? shoppingAction(button.callback_data) : null))
      .toEqual(expect.arrayContaining(['edit_name', 'edit_phone', 'edit_type', 'edit_address', 'edit_time'].map(choice => ({
        kind: 'flow', revision: s.id, choice,
      }))));
    expect(buttons.find(button => button.text === 'Отмена')).toMatchObject({ style: 'danger' });
    expect(screen.text).not.toContain('a'.repeat(64));
    expect(screen.text).not.toContain(s.id);
    const changed = checkoutScreen(s, { ...basket, revision: randomUUID() });
    expect('keyboard' in changed && changed.keyboard.inline_keyboard.flat().some(button => button.text === '✅ Создать заказ')).toBe(false);
  });
  it('shows the real preorder slots and does not suggest ASAP while it is unavailable', () => {
    const offer = { queueLength: 0, position: 1, wait: { min: 0, max: 0 }, estimatedAssemblyMinutes: 25,
      assemblyConcurrency: 1, showScheduledOffer: false, peakModeActive: false, preorderRequired: true,
      preparationStartsAt: null, market: { isOpen: false, timezone: 'Europe/Moscow', today: '2026-10-22',
        openTime: '09:00', closeTime: '21:00', nextOpenAt: null },
      slots: [{ at: '2099-01-01T12:00:00.000Z', reserved: 0, capacity: 1 }] };
    const screen = checkoutScreen(session('TIME'), null, offer);
    expect('prompt' in screen && screen.prompt).toContain('Сейчас доступен предзаказ');
    expect('prompt' in screen && screen.prompt).toContain('Ближайшие свободные слоты');
    expect('prompt' in screen && screen.prompt).not.toContain('«-» — как можно скорее');
    const full = checkoutScreen(session('TIME'), null, { ...offer, slots: [] });
    expect('prompt' in full && full.prompt).toContain('Свободных интервалов пока нет');
  });
  it('only passes explicit safe business messages to the user', () => {
    expect(
      customerError(new BadRequestException('opaque provider body'), true),
    ).not.toContain('opaque');
    expect(
      customerError(new Error('opaque provider body'), true),
    ).toBeUndefined();
    expect(
      customerError(
        new BadRequestException('Доставка временно недоступна.'),
        true,
      ),
    ).toBe('Доставка временно недоступна.');
  });
});


it('payment display distinguishes free delivery and offers an authoritative refresh and seller help', () => {
  const free = { ...order(), deliveryPrice: 0 };
  const screen = paymentScreen(free, 'SBP');
  expect(screen.text).toContain('Доставка: бесплатно');
  expect(screen.text).not.toContain('оплачивается отдельно');
  expect(callbacks(screen)).toContain('s:p:' + publicId.replaceAll('-', '') + ':SBP');
  expect(screen.keyboard.inline_keyboard.flat().some(button => button.text === '💬 Вопрос по оплате')).toBe(true);
});

it('a canceled order never shows bank details even if the stored payment is still awaiting', () => {
  const screen = paymentScreen({ ...order(), status: 'CANCELED' }, 'SBP');
  expect(screen.text).toContain('Оплата пока недоступна');
  expect(screen.text).not.toContain('fixture phone');
  expect(screen.text).not.toContain('К оплате за товары');
});

it('clear confirmation preserves unknown whole-item estimates and explains existing orders are safe', () => {
  const basket = { revision: publicId, goodsTotal: null, items: [{ productId: 1 }] } as unknown as Awaited<ReturnType<CartService['get']>>;
  const screen = clearCartScreen(basket);
  expect(screen.text).toContain('после взвешивания');
  expect(screen.text).toContain('Уже оформленные заказы сохранятся');
  expect(callbacks(screen).map(shoppingAction)).toContainEqual({ kind: 'clearConfirmed', revision: publicId });
});

it('help explains monetary, whole-item and conversation boundaries within one Telegram message', () => {
  const screen = shoppingHelpScreen();
  expect(screen.text.length).toBeLessThan(4096);
  for (const phrase of ['Целые экземпляры', '/cancel', 'только текущий ввод', 'фото и отметки']) {
    expect(screen.text).toContain(phrase);
  }
});


it('offers delivery-comment editing separately and preserves the previous comment in the prompt', () => {
  const session = { id: publicId, step: 'COMMENT', promptMessageId: null,
    payload: { cartRevision: publicId, quoteToken: 'a'.repeat(64), type: 'DELIVERY',
      address: { city: 'Москва', street: 'Тестовая', house: '1', comment: 'Не звонить в домофон' } } } as unknown as CustomerTelegramSession;
  const screen = checkoutScreen(session, null);
  expect('prompt' in screen && screen.prompt).toContain('Сейчас: Не звонить в домофон');
  expect('prompt' in screen && screen.prompt).toContain('заменит только комментарий');
  expect('prompt' in screen && screen.prompt).toContain('убрать его');
});
