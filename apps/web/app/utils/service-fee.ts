import { apiError } from './api-error';

export function servicePercent(value: string | number): number | null {
  if (!/^\d{1,3}$/.test(String(value).trim())) return null;
  const percent = Number(value);
  return percent <= 100 ? percent : null;
}

export function serviceFeeError(cause: unknown): string {
  if (cause && typeof cause === 'object') {
    const error = cause as { status?: number; statusCode?: number; response?: { status?: number } };
    if ([error.status, error.statusCode, error.response?.status].includes(409)) {
      return 'Настройки сейчас обновляются или используются при оформлении заказа. Повторите попытку';
    }
  }
  return apiError(cause);
}
