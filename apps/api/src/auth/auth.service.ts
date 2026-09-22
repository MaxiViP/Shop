import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { phone as normalizePhone } from '../common/phone.js';
import { DbService } from '../db/db.service.js';
import type { Prisma } from '../db/gen/client.js';
import { guestTokenHash } from '../common/guest.js';
import { adminPhone } from './admin.config.js';
import { authUser, authUserSelect } from './auth-user.js';

const OTP_TTL = 5 * 60 * 1000;
const OTP_COOLDOWN = 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
export const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;

export const SID = process.env.NODE_ENV === 'production' ? '__Host-sid' : 'sid';

@Injectable()
export class AuthService {
  private readonly secret: string;

  constructor(private readonly db: DbService) {
    const secret = process.env.AUTH_SECRET;

    if (!secret) {
      throw new Error('AUTH_SECRET is not set');
    }

    this.secret = secret;
  }

  method(value: unknown): { method: 'OTP' | 'PASSWORD' } {
    const phone = normalizePhone(value);
    return { method: phone === adminPhone() ? 'PASSWORD' : 'OTP' };
  }

  async code(value: unknown) {
    const phone = normalizePhone(value);
    await this.rejectAdminOtp(phone);
    const code = await this.db.$transaction(async (db) => {
      await this.lockOtp(db, phone);
      const now = Date.now();
      const current = await db.otp.findUnique({ where: { phone } });
      if (current && now - current.createdAt.getTime() < OTP_COOLDOWN) {
        throw new HttpException(
          'Повторите запрос через минуту',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      const code = String(randomInt(100000, 1000000));
      const data = {
        id: randomUUID(),
        codeHash: this.codeHash(phone, code),
        attempts: 0,
        expiresAt: new Date(now + OTP_TTL),
        createdAt: new Date(now),
      };
      await db.otp.upsert({
        where: { phone },
        create: { phone, ...data },
        update: data,
      });
      return code;
    });

    // A future SMS adapter must run after this transaction commits, never inside it.
    return process.env.NODE_ENV === 'production'
      ? { ok: true }
      : {
          ok: true,
          devCode: code,
        };
  }

  async login(
    phoneValue: unknown,
    codeValue: unknown,
    guestToken?: string,
    currentUserId?: number,
    previousToken?: string,
  ) {
    const phone = normalizePhone(phoneValue);
    await this.rejectAdminOtp(phone);

    if (typeof codeValue !== 'string' || !/^\d{6}$/.test(codeValue)) {
      throw new BadRequestException('Некорректный код');
    }

    const result = await this.db.$transaction(async (db) => {
      await this.lockOtp(db, phone);
      const otp = await db.otp.findUnique({ where: { phone } });
      if (!otp || otp.expiresAt.getTime() <= Date.now())
        throw new UnauthorizedException('Код истёк или не существует');
      if (otp.attempts >= OTP_MAX_ATTEMPTS)
        throw new HttpException(
          'Слишком много попыток',
          HttpStatus.TOO_MANY_REQUESTS,
        );

      if (!this.equal(otp.codeHash, this.codeHash(phone, codeValue))) {
        await db.otp.update({
          where: { id: otp.id },
          data: { attempts: { increment: 1 } },
        });
        // Throwing here would roll the increment back. Commit it before returning 401.
        return null;
      }

      const consumed = await db.otp.deleteMany({
        where: { phone, id: otp.id, expiresAt: { gt: new Date() } },
      });
      if (consumed.count !== 1)
        throw new UnauthorizedException(
          'Код истёк или был заменён. Запросите новый код',
        );
      const select = authUserSelect;
      // Serialize phone attachment for the same account as well as the OTP phone.
      if (currentUserId)
        await db.$executeRaw`SELECT pg_advisory_xact_lock(704004, ${currentUserId}::integer)`;
      const owner = currentUserId
        ? await db.user.findUnique({ where: { phone }, select })
        : null;
      if (owner && owner.id !== currentUserId)
        throw new ConflictException('ACCOUNT_LINK_REQUIRED');
      const current = currentUserId
        ? await db.user.findUnique({ where: { id: currentUserId }, select })
        : null;
      if (currentUserId && (!current || current.role === 'ADMIN'))
        throw new UnauthorizedException();
      // Changing an existing verified number needs its own account recovery flow.
      if (current?.phone && current.phone !== phone)
        throw new ConflictException('ACCOUNT_LINK_REQUIRED');
      const user = current
        ? await db.user.update({
            where: { id: current.id },
            data: { phone, verifiedAt: new Date() },
            select,
          })
        : await db.user.upsert({
            where: { phone },
            update: { verifiedAt: new Date() },
            create: { phone, verifiedAt: new Date() },
            select,
          });
      if (user.role === 'ADMIN' || user.phone === adminPhone())
        throw new UnauthorizedException('Используйте вход администратора');
      if (guestToken) {
        const guest = await db.guestSession.findUnique({
          where: {
            tokenHash: guestTokenHash(guestToken),
          },

          select: {
            id: true,
            expiresAt: true,
          },
        });

        if (guest && guest.expiresAt.getTime() > Date.now()) {
          await db.order.updateMany({
            where: {
              guestSessionId: guest.id,
              customerPhone: phone,
              userId: null,
            },

            data: {
              userId: user.id,
            },
          });
        }
      }

      const token = await this.createSession(db, user.id, previousToken);

      return { token, user: authUser(user) };
    });

    if (!result) throw new UnauthorizedException('Неверный код');
    return result;
  }

  private async lockOtp(db: Prisma.TransactionClient, phone: string) {
    // A row lock alone cannot serialize the first request when Otp does not exist.
    // All code/login writers use this transaction-scoped, per-phone lock.
    // Hash collisions only serialize unrelated phones; no state is shared.
    await db.$executeRaw`SELECT pg_advisory_xact_lock(704002, hashtext(${phone}))`;
  }

  async me(token?: string) {
    if (!token) return null;

    const tokenHash = this.tokenHash(token);

    const session = await this.db.session.findUnique({
      where: { tokenHash },

      select: {
        id: true,
        expiresAt: true,
        lastUsedAt: true,

        user: {
          select: authUserSelect,
        },
      },
    });

    if (!session) return null;

    if (session.expiresAt.getTime() < Date.now()) {
      await this.db.session.delete({
        where: {
          id: session.id,
        },
      });

      return null;
    }

    const day = 24 * 60 * 60 * 1000;

    if (Date.now() - session.lastUsedAt.getTime() > day) {
      await this.db.session.update({
        where: {
          id: session.id,
        },

        data: {
          lastUsedAt: new Date(),
        },
      });
    }

    if (
      session.user.role === 'ADMIN' &&
      (!adminPhone() || session.user.phone !== adminPhone())
    )
      return null;
    return authUser(session.user);
  }

  private async rejectAdminOtp(phone: string) {
    const user = await this.db.user.findUnique({
      where: { phone },
      select: { role: true },
    });
    if (phone === adminPhone() || user?.role === 'ADMIN')
      throw new UnauthorizedException('Используйте вход администратора');
  }

  async adminLogin(phoneValue: string, password: string) {
    let phone: string | null = null;
    try {
      phone = normalizePhone(phoneValue);
    } catch {
      /* same credential error */
    }
    const configured = adminPhone();
    const expected = process.env.ADMIN_PASSWORD;
    const passwordValid = this.equal(
      this.tokenHash(password),
      this.tokenHash(expected ?? ''),
    );
    if (!configured || !expected || phone !== configured || !passwordValid)
      throw new UnauthorizedException('Неверные данные для входа');
    return this.db.$transaction(async (db) => {
      // Serialize admin bootstrap; old admin sessions must not survive a configured phone change.
      await db.$executeRaw`SELECT pg_advisory_xact_lock(704001)`;
      await db.session.deleteMany({
        where: {
          user: {
            role: 'ADMIN',
            OR: [{ phone: null }, { phone: { not: configured } }],
          },
        },
      });
      await db.user.updateMany({
        where: {
          role: 'ADMIN',
          OR: [{ phone: null }, { phone: { not: configured } }],
        },
        data: { role: 'USER' },
      });
      const existing = await db.user.findUnique({
        where: { phone: configured },
        select: { id: true, role: true },
      });
      if (existing && existing.role !== 'ADMIN')
        await db.session.deleteMany({ where: { userId: existing.id } });
      const result = await db.user.upsert({
        where: { phone: configured },
        update: { role: 'ADMIN' },
        create: { phone: configured, role: 'ADMIN' },
        select: authUserSelect,
      });
      const token = await this.createSession(db, result.id);
      return { user: authUser(result), token };
    });
  }

  async createSession(
    db: Prisma.TransactionClient,
    userId: number,
    previousToken?: string,
  ) {
    const token = randomBytes(32).toString('hex');
    if (previousToken)
      await db.session.deleteMany({
        where: { tokenHash: this.tokenHash(previousToken) },
      });
    await db.session.create({
      data: {
        userId,
        tokenHash: this.tokenHash(token),
        expiresAt: new Date(Date.now() + SESSION_TTL),
      },
    });
    return token;
  }

  async logout(token?: string) {
    if (!token) return;

    await this.db.session.deleteMany({
      where: {
        tokenHash: this.tokenHash(token),
      },
    });
  }

  private codeHash(phone: string, code: string) {
    return createHmac('sha256', this.secret)
      .update(`${phone}:${code}`)
      .digest('hex');
  }

  private tokenHash(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  private equal(a: string, b: string) {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  }
}
