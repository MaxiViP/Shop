export const customerCommands = [
  { command: 'start', description: 'Начать покупки' },
  { command: 'catalog', description: 'Каталог товаров' },
  { command: 'cart', description: 'Моя корзина' },
  { command: 'orders', description: 'Мои заказы' },
  { command: 'quick', description: 'Быстрые покупки' },
  { command: 'delivery', description: 'Доставка и самовывоз' },
  { command: 'menu', description: 'Главное меню' },
  { command: 'help', description: 'Помощь' },
] as const;

export function customerCommand(text: string | undefined) {
  return text?.trim().split(/\s+/)[0]?.replace(/@[a-zA-Z0-9_]{5,32}$/, '');
}
