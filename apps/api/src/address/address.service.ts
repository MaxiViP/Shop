import { Injectable, NotFoundException } from '@nestjs/common';
import { DbService } from '../db/db.service.js';
import type { AddressInput, AddressUpdate } from './schema.js';

@Injectable()
export class AddressService {
  constructor(private readonly db: DbService) {}

  list(userId: number) {
    return this.db.address.findMany({
      where: { userId },

      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
  }

  async create(userId: number, data: AddressInput) {
    return this.db.$transaction(async (db) => {
      const count = await db.address.count({
        where: { userId },
      });

      const isDefault = data.isDefault || count === 0;

      if (isDefault) {
        await db.address.updateMany({
          where: { userId },
          data: {
            isDefault: false,
          },
        });
      }

      return db.address.create({
        data: {
          ...data,
          isDefault,
          userId,
        },
      });
    });
  }

  async update(userId: number, id: number, data: AddressUpdate) {
    await this.find(userId, id);

    return this.db.address.update({
      where: { id },
      data,
    });
  }

  async remove(userId: number, id: number) {
    return this.db.$transaction(async (db) => {
      const address = await db.address.findFirst({
        where: {
          id,
          userId,
        },
      });

      if (!address) {
        throw new NotFoundException('Адрес не найден');
      }

      await db.address.delete({
        where: { id },
      });

      if (address.isDefault) {
        const next = await db.address.findFirst({
          where: { userId },

          orderBy: {
            createdAt: 'asc',
          },
        });

        if (next) {
          await db.address.update({
            where: {
              id: next.id,
            },

            data: {
              isDefault: true,
            },
          });
        }
      }

      return { ok: true };
    });
  }

  async setDefault(userId: number, id: number) {
    await this.find(userId, id);

    return this.db.$transaction(async (db) => {
      await db.address.updateMany({
        where: { userId },

        data: {
          isDefault: false,
        },
      });

      return db.address.update({
        where: { id },

        data: {
          isDefault: true,
        },
      });
    });
  }

  private async find(userId: number, id: number) {
    const address = await this.db.address.findFirst({
      where: {
        id,
        userId,
      },
    });

    if (!address) {
      throw new NotFoundException('Адрес не найден');
    }

    return address;
  }
}
