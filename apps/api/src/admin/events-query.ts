import { createHmac, timingSafeEqual } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { Prisma } from '../db/gen/client.js';

export const eventCategories = [
  'ORDERS',
  'SALES',
  'RECEIPTS',
  'SELLERS',
  'ADMINISTRATORS',
  'SYSTEM',
] as const;
const positiveId = z.coerce.number().int().positive().max(2147483647);
const day = z.iso.date();
export const eventsQuery = z
  .object({
    category: z.enum(eventCategories).optional(),
    actorId: positiveId.optional(),
    orderId: positiveId.optional(),
    from: day.optional(),
    to: day.optional(),
    q: z.string().trim().max(160).optional(),
    before: positiveId.optional(),
  })
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: 'Проверьте период',
  });
export type EventsQuery = z.infer<typeof eventsQuery>;

export function eventWhere(query: EventsQuery, primary: boolean): Prisma.Sql {
  const parts = [primary ? Prisma.sql`TRUE` : Prisma.sql`e."ownerOnly"=false`];
  if (query.category) parts.push(Prisma.sql`e.category=${query.category}`);
  if (query.actorId) parts.push(Prisma.sql`e."actorId"=${query.actorId}`);
  if (query.orderId) parts.push(Prisma.sql`e."orderId"=${query.orderId}`);
  if (query.from)
    parts.push(
      Prisma.sql`e."createdAt">=${new Date(query.from + 'T00:00:00+03:00')}`,
    );
  if (query.to)
    parts.push(
      Prisma.sql`e."createdAt"<${new Date(new Date(query.to + 'T00:00:00+03:00').getTime() + 86400000)}`,
    );
  if (query.q)
    parts.push(Prisma.sql`e.search @@ plainto_tsquery('russian',${query.q})`);
  return Prisma.join(parts, ' AND ');
}

type Cursor = { snapshot: string; at: number; scope: string };
function secret() {
  const value = process.env.AUTH_SECRET;
  if (!value) throw new Error('AUTH_SECRET is not set');
  return value;
}
export function cursorScope(
  userId: number,
  primary: boolean,
  query: EventsQuery,
): string {
  return JSON.stringify([
    userId,
    primary,
    query.category,
    query.actorId,
    query.orderId,
    query.from,
    query.to,
    query.q || undefined,
  ]);
}
export function signEventCursor(snapshot: string, scope: string): string {
  const data = Buffer.from(
    JSON.stringify({ snapshot, scope, at: Date.now() }),
  ).toString('base64url');
  return (
    data + '.' + createHmac('sha256', secret()).update(data).digest('base64url')
  );
}
export function readEventCursor(token: string, scope: string): Cursor {
  try {
    if (token.length > 24000) throw new Error();
    const [data, signature, extra] = token.split('.');
    if (!data || !signature || extra) throw new Error();
    const expected = createHmac('sha256', secret()).update(data).digest();
    const supplied = Buffer.from(signature, 'base64url');
    if (
      expected.length !== supplied.length ||
      !timingSafeEqual(expected, supplied)
    )
      throw new Error();
    const parsed = z
      .object({
        snapshot: z
          .string()
          .max(16000)
          .regex(/^\d+:\d+:(?:\d+(?:,\d+)*)?$/),
        at: z.number(),
        scope: z.string(),
      })
      .parse(JSON.parse(Buffer.from(data, 'base64url').toString()));
    if (
      parsed.scope !== scope ||
      parsed.at > Date.now() + 60000 ||
      Date.now() - parsed.at > 7 * 86400000
    )
      throw new Error();
    return parsed;
  } catch {
    throw new BadRequestException('Курсор устарел. Обновите ленту.');
  }
}
