import type { OrderStatus, Address, CustomerTelegramSession } from '../db/gen/client.js';
import { customerCommands, customerCommand } from './customer-commands.js';
import { historyButton } from './customer-view.js';
import { shoppingAction, shoppingData } from './shopping-callback.js';
import { customerScreen, richMessage, fallbackHtml, validScreen } from './rich.js';
import { receivingScreen } from './receiving.js';

const revision = '11111111-1111-4111-8111-111111111111';
const order = { id: 125, publicId: revision, total: 195099, finalTotal: null, status: 'ASSEMBLING' as OrderStatus,
  createdAt: new Date('2026-10-23T21:35:00Z'), pending: 0, customerUnread: 0 };
it.each(['NEW', 'CONFIRMED', 'ASSEMBLING', 'READY', 'DELIVERING', 'COMPLETED', 'CANCELED'] as OrderStatus[])(
  'uses one bounded %s history button with real money and Moscow date across midnight', status => {
    const button = historyButton({ ...order, status }, false);
    expect(button.text).toContain('№125'); expect(button.text).toContain('Предв. ≈1\u00a0950,99 ₽');
    expect(button.text).toContain('24.10 00:35'); expect(button.text.length).toBeLessThan(180);
    expect(shoppingAction('delivery')).toEqual({ kind: 'receiving' });
    expect(button.style).toBe(status === 'COMPLETED' ? 'success' : status === 'CANCELED' ? 'danger' : undefined);
  });
it('distinguishes unknown, zero and final totals, and retains both attention counters', () => {
  expect(historyButton({ ...order, total: null }, false).text).toContain('Сумма уточняется');
  expect(historyButton({ ...order, finalTotal: 0 }, false).text).toContain('Итог 0 ₽');
  const button = historyButton({ ...order, finalTotal: 280100, pending: 2, customerUnread: 3 }, true);
  expect(button.text).toContain('Итог 2\u00a0801 ₽'); expect(button.text).toContain('❗2 · 💬3'); expect(button.style).toBe('primary');
  expect(button).toHaveProperty('callback_data', 'c:q:' + revision.replaceAll('-', '') + ':0');
});
it('uses supported customer button alignment and emphasizes text money/order IDs without formatting button labels', () => {
  const source = { text: 'Заказ №125\nИтого: ≈1 950,99 ₽ <test>', keyboard: { inline_keyboard: [[{ text: '125 ₽', callback_data: 'cart' }]] },
    rich: { blocks: [{ type: 'paragraph' as const, text: 'Заказ №125 · ≈1 950,99 ₽' },
      { type: 'details' as const, summary: 'Действия', blocks: [{ type: 'buttons' as const, buttons: [{ text: 'Корзина', callback_data: 'cart' }] }] }] } };
  const screen = customerScreen(source), blocks = richMessage(screen).blocks;
  expect(blocks[0]).toEqual({ type: 'paragraph', text: [{ type: 'bold', text: 'Заказ №125' }, ' · ', { type: 'bold', text: '≈1 950,99 ₽' }] });
  expect(blocks.at(-1)).toMatchObject({ type: 'buttons', align: 'left', buttons: [{ text: '125 ₽' }] });
  expect(blocks[1]).toMatchObject({ type: 'details', blocks: [{ type: 'buttons', align: 'left' }] });
  expect(fallbackHtml(screen.text, screen.fallback)).toContain('<b>≈1 950,99 ₽</b> &lt;test&gt;');
  expect(richMessage(source).blocks.at(-1)).not.toHaveProperty('align'); // STAFF/shared rendering is unchanged.
  expect(validScreen(screen)).toBe(true);
});
it('publishes exactly the requested CUSTOMER commands and parses bot-name suffixes', () => {
  expect(customerCommands.map(value => value.command)).toEqual(['start', 'catalog', 'cart', 'orders', 'quick', 'delivery', 'menu', 'help']);
  expect(customerCommand('/quick@KorzinaMarket_bot extra')).toBe('/quick');
  expect(shoppingAction('quick')).toEqual({ kind: 'quick', page: 0 });
});
it.each(['pickup', 'delivery', 'use', 'edit', 'new', 'save'] as const)('round-trips a revision-bound receiving %s callback', choice => {
  const data = shoppingData('g', revision, choice);
  expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
  expect(shoppingAction(data)).toEqual({ kind: 'receive', revision, choice });
});
it.each(['s:g:bad:save', shoppingData('g', revision, 'view', 0), shoppingData('g', revision, 'save', 1),
  shoppingData('g', revision, 'view', 1) + ':extra', shoppingData('g', revision, 'page', 10001)])('rejects malformed receiving action %s', data => {
  expect(shoppingAction(data)).toBeNull();
});
it('shows saved-address controls, pending review and short-lived method truthfully without checkout actions', () => {
  const address = { id: 9, label: 'Дом', city: 'Москва', street: 'Тестовая', house: '1', isDefault: true } as Address;
  for (const step of ['TYPE', 'ADDRESS', 'VIEW', 'REVIEW', 'DONE']) {
    const session = { id: revision, action: 'CHECKOUT', step, expiresAt: new Date('2026-10-23T10:30:00Z'), payload: { purpose: 'RECEIVING', stage: step, type: 'DELIVERY', addressId: 9, address } } as unknown as CustomerTelegramSession;
    const screen = receivingScreen(session, [address], 1);
    if ('prompt' in screen) throw new Error('Unexpected prompt');
    expect(validScreen(screen)).toBe(true);
    expect(screen.keyboard.inline_keyboard.flat().some(button => 'callback_data' in button && shoppingAction(button.callback_data)?.kind === 'checkout')).toBe(false);
    if (step === 'DONE') { expect(screen.text).toContain('30 минут'); expect(screen.text).toContain('Заказ ещё не создан'); }
    if (step === 'ADDRESS') { expect(screen.text).not.toContain('Тестовая'); expect(screen.text).not.toContain('Страница'); }
  }
});
