import { z } from 'zod';
import { clip, money as formatMoney } from './message.js';
export { quantity } from './message.js';

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const chat = z.object({ id: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), type: z.string() });
const actor = z.object({ id, is_bot: z.literal(false) });
const message = z.object({
  message_id: id, from: actor, chat, text: z.string().max(4096).optional(),
  reply_to_message: z.object({ message_id: id }).optional(),
});
const callback = z.object({
  id: z.string().min(1).max(256), from: actor, data: z.string().max(64),
  message: z.object({ message_id: id, chat }),
});
export const staffUpdate = z.object({
  message: message.optional(), callback_query: callback.optional(),
});
export type StaffMessage = z.infer<typeof message>;
export type StaffCallback = z.infer<typeof callback>;

const actions = [
  'o', 'i', 'v', 'w', 'q', 'm', 'r', 'f', 'p', 'u', 'd', 'h', 'c',
  'x', 'xl', 'xe', 'xd', 'xs', 'ds', 'z', 'zy', 'zb', 'b',
] as const;
type Action = typeof actions[number];

export function parseStaffAction(data: string): { orderId: number; action: Action; arg?: number; code?: string } | null {
  const confirmed = /^s:([1-9]\d{0,9}):(xs|ds|zy):([0-9a-f]{16})$/.exec(data);
  if (confirmed && Number(confirmed[1]) <= 2147483647)
    return { orderId: Number(confirmed[1]), action: confirmed[2] as Action, code: confirmed[3] };
  const match = /^s:([1-9]\d{0,9}):([a-z]{1,2})(?::(0|[1-9]\d{0,9}))?$/.exec(data);
  if (!match || Number(match[1]) > 2147483647 || !actions.includes(match[2] as Action)) return null;
  const arg = match[3] === undefined ? undefined : Number(match[3]);
  if (arg !== undefined && (!Number.isSafeInteger(arg) || arg > 2147483647)) return null;
  const action = match[2] as Action;
  if (['v','w','q','m','r','xe','xd'].includes(action) && (!arg || arg < 1)) return null;
  if (!['v','w','q','m','r','xe','xd','i'].includes(action) && arg !== undefined) return null;
  if (['xs','ds','zy'].includes(action)) return null;
  return { orderId: Number(match[1]), action, ...(arg !== undefined ? { arg } : {}) };
}

export const staffData = (orderId: number, action: Action, arg?: number) =>
  's:' + orderId + ':' + action + (arg === undefined ? '' : ':' + arg);
export const staffConfirmData = (orderId: number, action: 'xs' | 'ds' | 'zy', code: string) =>
  's:' + orderId + ':' + action + ':' + code;

export function rublesToKopecks(input: string): number | null {
  const match = /^(0|[1-9]\d{0,6})(?:[.,](\d{1,2}))?$/.exec(input.trim());
  if (!match) return null;
  const value = BigInt(match[1]!) * 100n + BigInt((match[2] ?? '').padEnd(2, '0') || '0');
  return value > 0n && value <= 2147483647n ? Number(value) : null;
}

export const positiveQty = (value: string, max = 1_000_000): number | null =>
  /^(?:[1-9]\d*)$/.test(value.trim()) && Number.isSafeInteger(Number(value.trim())) &&
  Number(value.trim()) <= max ? Number(value.trim()) : null;

export const clean = (value: string | null | undefined, max = 200) => clip(value ?? '', max);
export const money = (cents: number | null | undefined) =>
  cents === null || cents === undefined ? 'уточняется' : formatMoney(cents);
