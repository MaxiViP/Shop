import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '../db/gen/client.js';
import { DbService } from '../db/db.service.js';
import { phone } from '../common/phone.js';

@Injectable()
export class OrderPhoneService {
  constructor(private readonly db: DbService) {}

  private async snapshot(db: Prisma.TransactionClient, userId: number) {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: {
        phone: true,
        orderPhone: true,
        telegramIdentity: {
          select: { phoneNumber: true, phoneVerified: true },
        },
        orderPhones: { orderBy: { id: 'asc' }, select: { id: true, phone: true } },
      },
    });
    if (!user) throw new NotFoundException('Аккаунт не найден');

    const phones: {
      id: number | null;
      phone: string;
      source: 'ACCOUNT' | 'TELEGRAM' | 'MANUAL';
      manualId?: number;
    }[] = [];
    if (user.phone) phones.push({ id: null, phone: user.phone, source: 'ACCOUNT' });
    const telegramPhone = user.telegramIdentity?.phoneVerified
      ? user.telegramIdentity.phoneNumber : null;
    if (telegramPhone && !phones.some((entry) => entry.phone === telegramPhone))
      phones.push({ id: null, phone: telegramPhone, source: 'TELEGRAM' });
    for (const entry of user.orderPhones) {
      const existing = phones.find((saved) => saved.phone === entry.phone);
      if (existing) existing.manualId = entry.id;
      else phones.push({ ...entry, source: 'MANUAL' });
    }

    return {
      phones,
      manualCount: user.orderPhones.length,
      primaryPhone: phones.find((entry) => entry.phone === user.orderPhone)?.phone
        ?? user.phone ?? telegramPhone ?? null,
    };
  }

  list(userId: number) {
    return this.db.$transaction((db) => this.snapshot(db, userId));
  }

  private async lock(db: Prisma.TransactionClient, userId: number) {
    const rows = await db.$queryRaw<{ id: number }[]>`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
    if (!rows.length) throw new NotFoundException('Аккаунт не найден');
  }

  private async unique(db: Prisma.TransactionClient, userId: number, value: string, exceptId?: number) {
    const user = await db.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        phone: true,
        telegramIdentity: { select: { phoneNumber: true, phoneVerified: true } },
      },
    });
    const telegram = user.telegramIdentity;
    if (value === user.phone || (telegram?.phoneVerified && value === telegram.phoneNumber))
      throw new ConflictException('Этот номер уже доступен для заказов');
    const duplicate = await db.orderPhone.findFirst({
      where: { userId, phone: value, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { id: true },
    });
    if (duplicate) throw new ConflictException('Этот номер уже добавлен');
  }

  create(userId: number, input: string) {
    const value = phone(input);
    return this.db.$transaction(async (db) => {
      await this.lock(db, userId);
      if (await db.orderPhone.count({ where: { userId } }) >= 5)
        throw new BadRequestException('Можно добавить не более пяти номеров');
      await this.unique(db, userId, value);
      await db.orderPhone.create({ data: { userId, phone: value } });
      return this.snapshot(db, userId);
    });
  }

  update(userId: number, id: number, input: string) {
    const value = phone(input);
    return this.db.$transaction(async (db) => {
      await this.lock(db, userId);
      const previous = await db.orderPhone.findFirst({ where: { id, userId } });
      if (!previous) throw new NotFoundException('Номер не найден');
      await this.unique(db, userId, value, id);
      await db.orderPhone.update({ where: { id }, data: { phone: value } });
      const available = await this.snapshot(db, userId);
      if (!available.phones.some((entry) => entry.phone === previous.phone))
        await db.user.updateMany({
          where: { id: userId, orderPhone: previous.phone },
          data: { orderPhone: value },
        });
      return this.snapshot(db, userId);
    });
  }

  remove(userId: number, id: number) {
    return this.db.$transaction(async (db) => {
      await this.lock(db, userId);
      const previous = await db.orderPhone.findFirst({ where: { id, userId } });
      if (!previous) throw new NotFoundException('Номер не найден');
      await db.orderPhone.delete({ where: { id } });
      const available = await this.snapshot(db, userId);
      if (!available.phones.some((entry) => entry.phone === previous.phone))
        await db.user.updateMany({
          where: { id: userId, orderPhone: previous.phone },
          data: { orderPhone: null },
        });
      return this.snapshot(db, userId);
    });
  }

  setPrimary(userId: number, input: string | null) {
    const value = input === null ? null : phone(input);
    return this.db.$transaction(async (db) => {
      await this.lock(db, userId);
      if (value) {
        const available = await this.snapshot(db, userId);
        if (!available.phones.some((entry) => entry.phone === value))
          throw new BadRequestException('Выберите сохранённый номер');
      }
      await db.user.update({ where: { id: userId }, data: { orderPhone: value } });
      return this.snapshot(db, userId);
    });
  }
}
