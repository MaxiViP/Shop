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
  update_id: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  message: message.optional(), callback_query: callback.optional(),
});
export type StaffMessage = z.infer<typeof message>;
export type StaffCallback = z.infer<typeof callback>;

const actions = [
  'o', 'i', 'j', 'v', 'w', 'q', 'a', 'm', 'r', 'f', 'p', 'u', 'd', 'h', 'c', 'k',
  'x', 'xl', 'xe', 'xd', 'xs', 'ds', 'z', 'zy', 'zb', 'b', 'ry', 'xy', 'fy', 'by', 'py',
] as const;
type Action = typeof actions[number];

export function parseStaffAction(data: string): { orderId: number; action: Action; arg?: number; code?: string } | null {
  const confirmed = /^s:([1-9]\d{0,9}):(xs|ds|zy|ry|xy|fy|by|py):([0-9a-f]{16})$/.exec(data);
  if (confirmed && confirmed[0] === data && Number(confirmed[1]) <= 2147483647)
    return { orderId: Number(confirmed[1]), action: confirmed[2] as Action, code: confirmed[3] };
  const match = /^s:([1-9]\d{0,9}):([a-z]{1,2})(?::(0|[1-9]\d{0,9}))?$/.exec(data);
  if (!match || match[0] !== data || Number(match[1]) > 2147483647 || !actions.includes(match[2] as Action)) return null;
  const arg = match[3] === undefined ? undefined : Number(match[3]);
  if (arg !== undefined && (!Number.isSafeInteger(arg) || arg > 2147483647)) return null;
  const action = match[2] as Action;
  if (['v','w','q','a','m','r','xe','xd'].includes(action) && (!arg || arg < 1)) return null;
  if (!['v','w','q','a','m','r','xe','xd','i','j','xl'].includes(action) && arg !== undefined) return null;
  if (['xs','ds','zy','ry','xy','fy','by','py'].includes(action)) return null;
  return { orderId: Number(match[1]), action, ...(arg !== undefined ? { arg } : {}) };
}

export const staffData = (orderId: number, action: Action, arg?: number) =>
  's:' + orderId + ':' + action + (arg === undefined ? '' : ':' + arg);
export const staffConfirmData = (orderId: number, action: 'xs' | 'ds' | 'zy' | 'ry' | 'xy' | 'fy' | 'by' | 'py', code: string) =>
  's:' + orderId + ':' + action + ':' + code;

export type StaffQueueFilter = 'all' | 'seller' | 'customer' | 'new' | 'assembly' | 'ready' | 'delivery';
export const staffQueueData = (filter: StaffQueueFilter, page = 0) => 'sq:' + filter + ':' + page;
export function parseStaffQueue(data: string): { filter: StaffQueueFilter; page: number } | null {
  const match = /^sq:(all|seller|customer|new|assembly|ready|delivery):(0|[1-9]\d{0,4})$/.exec(data);
  return match && match[0] === data && Number(match[2]) <= 10000
    ? { filter: match[1] as StaffQueueFilter, page: Number(match[2]) } : null;
}

export function staffOrderCommand(text: string): number | null {
  const match = /^(?:\/order(?:[ _]#?)?|#)([1-9]\d{0,9})$/.exec(text);
  return match && match[0] === text && Number(match[1]) <= 2147483647 ? Number(match[1]) : null;
}

export function rublesToKopecks(input: string): number | null {
  const match = /^(0|[1-9]\d{0,6})(?:[.,](\d{1,2}))?$/.exec(input.trim());
  if (!match) return null;
  const value = BigInt(match[1]!) * 100n + BigInt((match[2] ?? '').padEnd(2, '0') || '0');
  return value > 0n && value <= 2147483647n ? Number(value) : null;
}

export const positiveQty = (value: string, max = 1_000_000): number | null =>
  /^(?:[1-9]\d*)$/.test(value.trim()) && Number.isSafeInteger(Number(value.trim())) &&
  Number(value.trim()) <= max ? Number(value.trim()) : null;

// A fraction without a unit is ambiguous. Explicit kg is parsed with integer
// arithmetic; the domain still receives positive integer grams.
export function weightGrams(input: string): number | null {
  const value = input.trim();
  const grams = /^([1-9]\d{0,6})\s*(?:г|g)$/iu.exec(value);
  if (grams) return positiveQty(grams[1]!);
  const kg = /^(0|[1-9]\d{0,3})(?:[.,](\d{1,3}))?\s*(?:кг|kg)$/iu.exec(value);
  if (!kg) return positiveQty(value);
  const result = BigInt(kg[1]!) * 1000n + BigInt((kg[2] ?? '').padEnd(3, '0') || '0');
  return result > 0n && result <= 1_000_000n ? Number(result) : null;
}

export const clean = (value: string | null | undefined, max = 200) => clip(value ?? '', max);
export const money = (cents: number | null | undefined) =>
  cents === null || cents === undefined ? 'уточняется' : formatMoney(cents);
