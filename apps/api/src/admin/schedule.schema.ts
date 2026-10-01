import { z } from 'zod';

export const weekdaySchema = z.coerce.number().int().min(1).max(7);
export const exceptionIdSchema = z.coerce.number().int().positive();
export const dateSchema = z.iso.date();
const minutes = z.number().int().min(0).max(1440);
export const weeklySchema = z.strictObject({
  enabled: z.boolean(), openMinutes: minutes, closeMinutes: minutes,
}).refine(data => data.openMinutes < data.closeMinutes && data.closeMinutes > 0,
  'Время открытия должно быть раньше закрытия');
export const exceptionSchema = z.strictObject({
  date: dateSchema, closed: z.boolean(),
  openMinutes: minutes.nullable(), closeMinutes: minutes.nullable(),
  note: z.string().trim().max(160).nullable(),
}).refine(data => data.closed
  ? data.openMinutes === null && data.closeMinutes === null
  : data.openMinutes !== null && data.closeMinutes !== null && data.openMinutes < data.closeMinutes,
'Укажите корректное время работы');
export type WeeklyInput = z.infer<typeof weeklySchema>;
export type ExceptionInput = z.infer<typeof exceptionSchema>;
