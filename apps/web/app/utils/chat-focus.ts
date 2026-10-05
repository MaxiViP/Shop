import type { ChatMessage } from '../types/coordination';

export function chatMessageId(value: unknown) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,9}$/.test(value)) return undefined;
  const id = Number(value);
  return Number.isSafeInteger(id) && id <= 2_147_483_647 ? id : undefined;
}

export function counterpartMessage(entry: ChatMessage, staff: boolean) {
  if (entry.recipient) return entry.recipient === (staff ? 'staff' : 'customer') || entry.recipient === 'both';
  return staff ? entry.authorType === 'CUSTOMER' : ['SELLER', 'ADMIN', 'SYSTEM'].includes(entry.authorType);
}

export function chatRectVisible(rect: { top: number; bottom: number; height: number },
  frame: { top: number; bottom: number }, screenHeight: number) {
  return rect.height > 0 && Math.min(rect.bottom, frame.bottom, screenHeight) -
    Math.max(rect.top, frame.top, 0) >= Math.min(48, rect.height / 2);
}

export function chatUpdateKey(messageId: number, version = 0) { return `${messageId}:${version}`; }
