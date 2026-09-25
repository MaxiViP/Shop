const orderPath = /^\/order\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const productPath = /^\/product\/[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function telegramReturnTo(value: unknown): string {
  if (typeof value !== 'string') return '/catalog';
  if (value === '/catalog' || orderPath.test(value) ||
    (value.length <= 189 && productPath.test(value))) return value;
  return '/catalog';
}
