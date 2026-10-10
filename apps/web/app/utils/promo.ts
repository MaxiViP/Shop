import type { PersonalPromo } from '../types/promo.ts';
import { money } from './money.ts';
export const promoStatusLabels = { AVAILABLE: 'Доступен', USED: 'Использован', EXPIRED: 'Истёк', REVOKED: 'Отозван' };
export function promoDescription(promo: Pick<PersonalPromo, 'type' | 'amount' | 'percentBps' | 'maxDiscount'>) {
  return promo.type === 'FIXED' ? 'Скидка ' + money(promo.amount ?? 0)
    : 'Скидка ' + ((promo.percentBps ?? 0) / 100).toLocaleString('ru-RU') + '% · не больше ' + money(promo.maxDiscount ?? 0);
}
export function promoDate(value: string) {
  return new Date(value).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'medium', timeStyle: 'short' });
}
