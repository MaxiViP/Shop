import {
  BadRequestException,
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
  timingSafeEqual,
} from 'node:crypto';
import { phone as normalizePhone } from '../common/phone.js';
import { DbService } from '../db/db.service.js';
import { guestTokenHash } from '../common/guest.js';

const OTP_TTL = 5 * 60 * 1000;
const OTP_COOLDOWN = 60 * 1000;
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;

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

  async code(value: unknown) {
    const phone = normalizePhone(value);
    const now = Date.now();

    const current = await this.db.otp.findUnique({
      where: { phone },
    });

    if (current && now - current.createdAt.getTime() < OTP_COOLDOWN) {
      throw new HttpException(
        'Повторите запрос через минуту',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const code = String(randomInt(100000, 1000000));

    const codeHash = this.codeHash(phone, code);

    await this.db.otp.upsert({
      where: { phone },

      update: {
        codeHash,
        attempts: 0,
        expiresAt: new Date(now + OTP_TTL),
        createdAt: new Date(),
      },

      create: {
        phone,
        codeHash,
        expiresAt: new Date(now + OTP_TTL),
      },
    });

    return process.env.NODE_ENV === 'production'
      ? { ok: true }
      : {
          ok: true,
          devCode: code,
        };
  }

  async login(phoneValue: unknown, codeValue: unknown, guestToken?: string) {
    const phone = normalizePhone(phoneValue);

    if (typeof codeValue !== 'string' || !/^\d{6}$/.test(codeValue)) {
      throw new BadRequestException('Некорректный код');
    }

    const otp = await this.db.otp.findUnique({
      where: { phone },
    });

    if (!otp || otp.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('Код истёк или не существует');
    }

    if (otp.attempts >= 5) {
      throw new HttpException(
        'Слишком много попыток',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const valid = this.equal(otp.codeHash, this.codeHash(phone, codeValue));

    if (!valid) {
      await this.db.otp.update({
        where: { phone },

        data: {
          attempts: {
            increment: 1,
          },
        },
      });

      throw new UnauthorizedException('Неверный код');
    }

    const token = randomBytes(32).toString('hex');

    const tokenHash = this.tokenHash(token);

    const expiresAt = new Date(Date.now() + SESSION_TTL);

    const user = await this.db.$transaction(async (db) => {
      const user = await db.user.upsert({
        where: { phone },

        update: {
          verifiedAt: new Date(),
        },

        create: {
          phone,
          verifiedAt: new Date(),
        },

        select: {
          id: true,
          phone: true,
          name: true,
          role: true,
          verifiedAt: true,
        },
      });

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

      await db.otp.delete({
        where: { phone },
      });

      await db.session.create({
        data: {
          tokenHash,
          expiresAt,
          userId: user.id,
        },
      });

      return user;
    });

    return {
      token,
      user,
    };
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
          select: {
            id: true,
            phone: true,
            name: true,
            role: true,
            verifiedAt: true,
          },
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

    return session.user;
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
