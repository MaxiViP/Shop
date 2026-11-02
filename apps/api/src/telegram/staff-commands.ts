export const staffCommands = [
  { command: 'start', description: 'Рабочий обзор' },
  { command: 'work', description: 'Рабочий обзор' },
  { command: 'orders', description: 'Все заказы' },
  { command: 'attention', description: 'Требуют действий' },
  { command: 'waiting', description: 'Ждём покупателя' },
  { command: 'resume', description: 'Продолжить ввод' },
  { command: 'cancel', description: 'Отменить ввод' },
  { command: 'help', description: 'Помощь' },
] as const;

export function staffCommand(text: string) {
  return text.replace(/^(\/[a-z]+)@[a-zA-Z0-9_]{5,32}(?=\s|$)/, '$1');
}
