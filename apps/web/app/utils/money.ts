export function money(value: number) {
  return `${(value / 100).toLocaleString("ru-RU")} ₽`;
}
