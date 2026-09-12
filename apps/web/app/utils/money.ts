export function money(value: number) {
  return `${(value / 100).toLocaleString("ru-RU")} ₽`;
}

export function knownMoney(value: number | null, unknown = "Рассчитывается") {
  return value === null ? unknown : money(value);
}

export function rublesToKopecks(value: string, allowZero = false): number | null {
  const match = /^(\d{1,7})(?:[.,](\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const price = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return price >= (allowZero ? 0 : 1) && price <= 100_000_000 ? price : null;
}

export function kopecksToRubles(value: number): string {
  return `${Math.trunc(value / 100)}.${String(value % 100).padStart(2, '0')}`;
}
