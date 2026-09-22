import { z } from 'zod';

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const from = z.object({ id, is_bot: z.literal(false) });
const chat = z.object({ id, type: z.string() });
export const customerUpdate = z.object({
  message: z.object({
    from,
    chat,
    text: z.string().max(256).optional(),
  }).optional(),
  callback_query: z.object({
    id: z.string().min(1).max(256),
    from,
    data: z.string().max(64),
    message: z.object({ chat }).optional(),
  }).optional(),
});

export function customerAction(data: string) {
  if (data === 'menu' || data === 'orders' || data === 'current') return data;
  const match = /^order:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(data);
  return match ? { publicId: match[1]! } : null;
}
