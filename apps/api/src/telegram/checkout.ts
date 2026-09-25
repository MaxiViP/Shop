import { z } from 'zod';
import { addressSchema, orderSchema } from '../order/schema.js';
import { phone } from '../common/phone.js';

export const checkoutPayload = z.object({
  cartRevision: z.uuid(),
  quoteToken: z.string().regex(/^[a-f0-9]{64}$/),
  type: orderSchema.shape.type.optional(),
  customerName: orderSchema.shape.customerName.optional(),
  customerPhone: orderSchema.shape.customerPhone.optional(),
  address: addressSchema.partial().optional(),
  deliveryAt: z.string().datetime().optional(),
  addressId: z.number().int().positive().optional(),
});
export type CheckoutPayload = z.infer<typeof checkoutPayload>;
export const checkoutSteps = [
  'TYPE',
  'NAME',
  'PHONE',
  'ADDRESS',
  'CITY',
  'STREET',
  'HOUSE',
  'FLAT',
  'ENTRANCE',
  'FLOOR',
  'INTERCOM',
  'COMMENT',
  'TIME',
  'CONFIRM',
] as const;
export const checkoutStep = z.enum(checkoutSteps);
export type CheckoutStep = z.infer<typeof checkoutStep>;
export const checkoutPrompts: Partial<Record<CheckoutStep, string>> = {
  NAME: 'Как к вам обращаться?',
  PHONE:
    'Телефон получателя заказа, например +7 999 123-45-67. Это контакт заказа, а не привязка телефона к аккаунту.',
  CITY: 'Город доставки.',
  STREET: 'Улица доставки.',
  HOUSE: 'Дом и корпус.',
  FLAT: 'Квартира. Если не нужна — отправьте «-».',
  ENTRANCE: 'Подъезд. Пропустить — «-».',
  FLOOR: 'Этаж. Пропустить — «-».',
  INTERCOM: 'Домофон. Пропустить — «-».',
  COMMENT: 'Комментарий к доставке. Пропустить — «-».',
  TIME: 'Когда получить заказ? «-» — как можно скорее, либо ДД.ММ.ГГГГ ЧЧ:ММ (московское время).',
};
const addressFields = {
  CITY: 'city',
  STREET: 'street',
  HOUSE: 'house',
  FLAT: 'flat',
  ENTRANCE: 'entrance',
  FLOOR: 'floor',
  INTERCOM: 'intercom',
  COMMENT: 'comment',
} as const;
export function checkoutInput(
  step: CheckoutStep,
  text: string,
  data: CheckoutPayload,
): CheckoutPayload {
  const next = { ...data };
  if (step === 'NAME')
    next.customerName = orderSchema.shape.customerName.parse(text);
  else if (step === 'PHONE')
    next.customerPhone = phone(orderSchema.shape.customerPhone.parse(text));
  else if (step === 'TIME') {
    if (text.trim() === '-') delete next.deliveryAt;
    else {
      const match = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})$/.exec(
        text.trim(),
      );
      if (!match) throw new Error('INPUT');
      const [, d, m, y, h, min] = match;
      const iso = y + '-' + m + '-' + d + 'T' + h + ':' + min + ':00+03:00';
      const date = new Date(iso);
      if (
        !Number.isFinite(date.getTime()) ||
        date.getTime() <= Date.now() ||
        new Date(date.getTime() + 10800000).toISOString().slice(0, 16) !==
          y + '-' + m + '-' + d + 'T' + h + ':' + min
      )
        throw new Error('INPUT');
      next.deliveryAt = date.toISOString();
    }
  } else if (Object.hasOwn(addressFields, step)) {
    const field = addressFields[step as keyof typeof addressFields];
    const value =
      text.trim() === '-' && !['city', 'street', 'house'].includes(field)
        ? ''
        : text;
    next.address = {
      ...data.address,
      [field]: addressSchema.shape[field].parse(value),
    };
  } else throw new Error('INPUT');
  return checkoutPayload.parse(next);
}
export function afterType(data: CheckoutPayload): CheckoutStep {
  return !data.customerName
    ? 'NAME'
    : !data.customerPhone
      ? 'PHONE'
      : data.type === 'DELIVERY'
        ? 'ADDRESS'
        : 'TIME';
}
export function afterText(
  step: CheckoutStep,
  data: CheckoutPayload,
): CheckoutStep {
  if (step === 'NAME') return afterType(data);
  if (step === 'PHONE') return data.type === 'DELIVERY' ? 'ADDRESS' : 'TIME';
  if (step === 'TIME') return 'CONFIRM';
  return checkoutSteps[checkoutSteps.indexOf(step) + 1] ?? 'CONFIRM';
}
