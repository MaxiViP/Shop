import { phone } from '../common/phone.js';

export function adminPhone(): string | null {
  try {
    return phone(process.env.ADMIN_PHONE);
  } catch {
    return null;
  }
}

export function allowedOrigin(origin: string): boolean {
  if (process.env.NODE_ENV !== 'production') {
    return /^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}$/.test(origin);
  }
  return (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .includes(origin);
}
