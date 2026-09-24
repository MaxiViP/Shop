import { z } from 'zod';

const actorId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const messageId = z.number().int().positive().max(2147483647);
const from = z.object({ id: actorId, is_bot: z.literal(false) });
const chat = z.object({ id: actorId, type: z.string() });
export const customerUpdate = z.object({
  message: z.object({
    message_id: messageId, from, chat,
    text: z.string().max(4096).optional(),
    reply_to_message: z.object({ message_id: messageId }).optional(),
  }).optional(),
  callback_query: z.object({
    id: z.string().min(1).max(256), from, data: z.string().max(256).optional(),
    message: z.object({ message_id: messageId, chat }).optional(),
  }).optional(),
}).refine(value => Boolean(value.message) !== Boolean(value.callback_query));

export const decisionCodes = {
  a: 'ACCEPT_ACTUAL', r: 'REQUEST_REDUCE', x: 'REMOVE_ITEM',
  p: 'ACCEPT_REPLACEMENT', c: 'CANCEL_ORDER',
} as const;
export type DecisionCode = keyof typeof decisionCodes;
type View = 'o' | 'q' | 'm' | 'w';
export type CustomerAction =
  | { kind: 'menu' | 'current' | 'attention' | 'cancel' }
  | { kind: 'orders'; page: number }
  | { kind: View; publicId: string; page: number }
  | { kind: 'd'; publicId: string; issueId: number; version: number; action: typeof decisionCodes[DecisionCode] };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function integer(value: string, max = 2147483647): number | null {
  if (!/^(0|[1-9a-z][0-9a-z]{0,5})$/.test(value)) return null;
  const result = Number.parseInt(value, 36);
  return Number.isSafeInteger(result) && result <= max ? result : null;
}
function expand(value: string): string | null {
  if (!/^[0-9a-f]{32}$/.test(value)) return null;
  return value.slice(0, 8) + '-' + value.slice(8, 12) + '-' + value.slice(12, 16) + '-' +
    value.slice(16, 20) + '-' + value.slice(20);
}
export function customerAction(data: string): CustomerAction | null {
  if (Buffer.byteLength(data, 'utf8') > 64) return null;
  if (data === 'menu' || data === 'current' || data === 'attention' || data === 'cancel')
    return { kind: data };
  if (data === 'orders') return { kind: 'orders', page: 0 };
  if (data.startsWith('order:') && uuid.test(data.slice(6)))
    return { kind: 'o', publicId: data.slice(6), page: 0 };
  const parts = data.split(':');
  if (parts[0] !== 'c') return null;
  if (parts[1] === 'l' && parts.length === 3) {
    const page = integer(parts[2]!, 10000);
    return page === null ? null : { kind: 'orders', page };
  }
  const publicId = expand(parts[2] ?? '');
  if (!publicId) return null;
  if (['o', 'q', 'm', 'w'].includes(parts[1]!) && parts.length === 4) {
    const page = integer(parts[3]!);
    return page === null ? null : { kind: parts[1] as View, publicId, page };
  }
  if (parts[1] !== 'd' || parts.length !== 6) return null;
  const issueId = integer(parts[3]!);
  const version = integer(parts[4]!);
  const code = parts[5]!;
  if (!issueId || !version || !Object.hasOwn(decisionCodes, code)) return null;
  return { kind: 'd', publicId, issueId, version, action: decisionCodes[code as DecisionCode] };
}
export function customerView(kind: View, publicId: string, page = 0) {
  return 'c:' + kind + ':' + publicId.replaceAll('-', '') + ':' + page.toString(36);
}
export function customerDecision(publicId: string, issueId: number, version: number, code: DecisionCode) {
  return 'c:d:' + publicId.replaceAll('-', '') + ':' + issueId.toString(36) + ':' + version.toString(36) + ':' + code;
}
