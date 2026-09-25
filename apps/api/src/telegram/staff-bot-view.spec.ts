import { dashboard, itemPage, itemView, type OrderView } from './staff-bot-view.js';

function fixture(): OrderView {
  return {
    id: 6, status: 'ASSEMBLING',
    items: [
      { id: 1, productName: 'Киви', qty: 3, unit: 'PIECE', status: 'PENDING' },
      { id: 2, productName: 'Клубника', qty: 1, unit: 'PACK', status: 'PENDING' },
      { id: 3, productName: 'Лук зелёный', qty: 2, unit: 'BUNCH', status: 'PENDING' },
      { id: 4, productName: 'Виноград', qty: 500, unit: 'GRAM', status: 'PENDING' },
      { id: 5, productName: 'Огурцы', qty: 2, unit: 'PIECE', status: 'PICKED' },
      { id: 6, productName: 'Авокадо', qty: 1, unit: 'PIECE', status: 'MISSING' },
    ], issues: [], extras: [],
  } as unknown as OrderView;
}

function buttons(view: { keyboard: { inline_keyboard: ({ text: string; callback_data?: string } | { text: string; url: string })[][] } }) {
  return view.keyboard.inline_keyboard.flat();
}

describe('STAFF position list', () => {
  it('shows requested quantity, unit and state for all positions', () => {
    const view = itemPage(fixture(), 0);
    const labels = buttons(view).map(button => button.text);
    expect(labels).toEqual(expect.arrayContaining([
      expect.stringContaining('Киви — 3 шт. · в сборке'),
      expect.stringContaining('Клубника — 1 уп. · в сборке'),
      expect.stringContaining('Лук зелёный — 2 пучка · в сборке'),
      expect.stringContaining('Виноград — 500 г · нужен вес'),
      expect.stringContaining('Огурцы — 2 шт. · собран'),
      expect.stringContaining('Авокадо — 1 шт. · нет в наличии'),
    ]));
    expect(view.text).toContain('6 из 6');
  });

  it.each(['PIECE', 'PACK', 'BUNCH'] as const)('offers instant and manual input for %s', unit => {
    const order = fixture();
    const item = order.items.find(value => value.unit === unit)!;
    const view = itemView(order, item);
    expect(buttons(view).map(button => button.text)).toContain('✅ По заказу');
    expect(buttons(view).map(button => button.text)).toContain('✏️ Изменить количество');
    expect(buttons(view).map(button => button.text)).toContain('❌ Нет в наличии');
    expect(buttons(itemPage(order, 0)).some(button =>
      'callback_data' in button && button.callback_data === 's:6:a:' + item.id)).toBe(true);
  });

  it('requires an actual weight for GRAM and keeps bulk action available', () => {
    const order = fixture();
    const weighted = order.items.find(item => item.unit === 'GRAM')!;
    expect(buttons(itemView(order, weighted)).map(button => button.text)).toContain('⚖️ Ввести вес');
    expect(buttons(itemView(order, weighted)).map(button => button.text)).not.toContain('✅ По заказу');
    const page = itemPage(order, 0);
    expect(buttons(page).some(button =>
      'callback_data' in button && button.callback_data === 's:6:a:4')).toBe(false);
    expect(buttons(dashboard(order)).some(button =>
      'callback_data' in button && button.callback_data === 's:6:k')).toBe(true);
  });

  it('does not offer quick pick for processed or issue-linked positions', () => {
    const order = fixture();
    (order.issues as { orderItemId: number; replacementItemId: number | null }[]).push({
      orderItemId: 1, replacementItemId: null,
    });
    const callbacks = buttons(itemPage(order, 0)).flatMap(button =>
      'callback_data' in button ? [button.callback_data] : []);
    expect(callbacks).not.toContain('s:6:a:1');
    expect(callbacks).not.toContain('s:6:a:5');
    expect(callbacks).not.toContain('s:6:a:6');
  });
});
