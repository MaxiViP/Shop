import { randomUUID } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import type { CustomerTelegramSession } from '../db/gen/client.js';
import { checkoutScreen, paymentScreen } from './shopping-view.js';
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
    'shows configured %s and reports that exact method',
    (method) => {
      const screen = paymentScreen(order(), method);
      expect(screen.text).toContain('Оплата заказа №7');
      expect(screen.text).toContain('123,45');
      expect(callbacks(screen).map(shoppingAction)).toContainEqual({
        kind: 'paid',
        publicId,
        method,
      });
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
  it('hides report when amount mismatches the finalized goods total or methods are unavailable', () => {
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
