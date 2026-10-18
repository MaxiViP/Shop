import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DbService } from '../db/db.service.js';
import type { Prisma } from '../db/gen/client.js';
import { adminPhone } from '../auth/admin.config.js';
import type { UserQuery } from './schema.js';
import { dbError } from './errors.js';

const select = {
  id: true,
  name: true,
  phone: true,
  role: true,
  ownedPoints: { select: { marketPointId: true, marketPoint: { select: { name: true } } } },
  verifiedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;
const orderSelect = {
  publicId: true,
  status: true,
  type: true,
  total: true,
  finalTotal: true,
  createdAt: true,
} satisfies Prisma.OrderSelect;
@Injectable()
export class AdminUsersService {
  constructor(private readonly db: DbService) {}
  private async stats(ids: number[]) {
    return this.db.$queryRaw<
      Array<{
        userId: number;
        orders: number;
        completed: number;
        spent: bigint;
        unknownTotals: number;
      }>
    >`
      SELECT "userId", COUNT(*)::int AS orders,
        COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS completed,
        COALESCE(SUM(COALESCE("finalTotal", total)) FILTER (WHERE status = 'COMPLETED'), 0)::bigint AS spent,
        COUNT(*) FILTER (WHERE status = 'COMPLETED' AND COALESCE("finalTotal", total) IS NULL)::int AS "unknownTotals"
      FROM "Order" WHERE "userId" = ANY(${ids}::int[]) GROUP BY "userId"`;
  }
  async list(query: UserQuery) {
    const { page, limit, search, role } = query;
    const where: Prisma.UserWhereInput = {
      ...(role === 'POINT_OWNER' ? { ownedPoints: { some: {} } } : role ? { role } : {}),
      ...(search
        ? {
            OR: [
              { phone: { contains: search } },
              { name: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [users, total] = await this.db.$transaction([
      this.db.user.findMany({
        where,
        select,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: [{ role: 'desc' }, { id: 'desc' }],
      }),
      this.db.user.count({ where }),
    ]);
    const stats = users.length
      ? await this.stats(users.map((user) => user.id))
      : [];
    return {
      items: users.map((user) => {
        const value = stats.find((item) => item.userId === user.id);
        return {
          ...user,
          protected:
            user.role === 'ADMIN' ||
            (user.phone !== null && user.phone === adminPhone()),
          orders: value?.orders ?? 0,
          completed: value?.completed ?? 0,
          spent: Number(value?.spent ?? 0),
          unknownTotals: value?.unknownTotals ?? 0,
        };
      }),
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
    };
  }
  async get(id: number) {
    const user = await this.db.user.findUnique({
      where: { id },
      select: {
        ...select,
        addresses: {
          select: {
            id: true,
            label: true,
            city: true,
            street: true,
            house: true, buildingPart: true,
            flat: true,
            entrance: true,
            floor: true,
            intercom: true,
            comment: true,
            isDefault: true,
          },
        },
        orders: {
          select: orderSelect,
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
      },
    });
    if (!user) throw new NotFoundException('Пользователь не найден');
    const [stats] = await this.stats([id]);
    return {
      ...user,
      stats: {
        orders: stats?.orders ?? 0,
        completed: stats?.completed ?? 0,
        spent: Number(stats?.spent ?? 0),
        unknownTotals: stats?.unknownTotals ?? 0,
      },
    };
  }
  async points(id: number, pointIds: number[], actorId: number) {
    return this.db.$transaction(async db => {
      await db.$queryRaw`SELECT id FROM "User" WHERE id = ${id} FOR UPDATE`;
      const user = await db.user.findUnique({ where: { id }, select });
      if (!user) throw new NotFoundException('Пользователь не найден');
      if (!user.phone && pointIds.length) throw new BadRequestException('Сначала привяжите номер телефона пользователя');
      const count = await db.marketPoint.count({ where: { id: { in: pointIds }, kind: { notIn: ['ENTRY', 'SERVICE'] } } });
      if (count !== pointIds.length) throw new BadRequestException('Выберите существующие торговые точки');
      await db.marketPointOwner.deleteMany({ where: { userId: id } });
      if (pointIds.length) await db.marketPointOwner.createMany({ data: pointIds.map(marketPointId => ({ userId: id, marketPointId })) });
      // Discard earlier sessions, including demo/test logins that do not prove phone ownership.
      await db.session.deleteMany({ where: { userId: id } });
      await db.adminAudit.create({ data: { actorId, action: 'POINT_OWNERS_CHANGED', entity: 'USER', entityId: String(id),
        oldValue: user.ownedPoints.map(point => point.marketPointId), newValue: pointIds } });
      return db.user.findUniqueOrThrow({ where: { id }, select });
    });
  }
  async role(id: number, role: 'USER' | 'SELLER') {
    if (role !== 'USER' && role !== 'SELLER') throw new ForbiddenException();
    try {
      return await this.db.$transaction(
        async (db) => {
          await db.$queryRaw`SELECT id FROM "User" WHERE id = ${id} FOR UPDATE`;
          const user = await db.user.findUniqueOrThrow({
            where: { id },
            select,
          });
          if (
            user.role === 'ADMIN' ||
            (user.phone !== null && user.phone === adminPhone())
          )
            throw new ForbiddenException('Роль администратора нельзя изменить');
          if (user.role !== role) await db.session.deleteMany({ where: { userId: id } });
          return db.user.update({ where: { id }, data: { role }, select });
        },
        { isolationLevel: 'Serializable' },
      );
    } catch (error) {
      return dbError(error);
    }
  }
}
