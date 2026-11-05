import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { DbService } from '../db/db.service.js';
import { AuthService } from './auth.service.js';
import { adminPhone } from './admin.config.js';
import { authUser, authUserSelect as select } from './auth-user.js';
import { verifyInitData, type TelegramProof } from './telegram-init-data.js';
import { customerBotToken } from '../telegram/bot-config.js';
import { phone } from '../common/phone.js';

@Injectable()
export class TelegramAuthService {
  private readonly logger = new Logger(TelegramAuthService.name);
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  miniApp(initData: string, previousToken?: string) {
    return this.login(
      verifyInitData(initData, customerBotToken(), Date.now(), (stage, diagnostics) => {
        this.logger.warn('Telegram Mini App failed: ' + stage);
        if (stage === 'HASH_INVALID' && diagnostics) {
          const yesNo = (value: boolean) => value ? 'yes' : 'no';
          this.logger.warn(
            'Telegram Mini App HASH_INVALID diagnostics: ' +
            'MINIAPP_FIELD_NAMES=' + JSON.stringify(diagnostics.fieldNames) +
            ' HAS_SIGNATURE=' + yesNo(diagnostics.hasSignature) +
            ' HMAC_CURRENT_MATCH=' + yesNo(diagnostics.hmacCurrentMatch) +
            ' HMAC_WITHOUT_SIGNATURE_MATCH=' + yesNo(diagnostics.hmacWithoutSignatureMatch) +
            ' ED25519_VALID=' + yesNo(diagnostics.ed25519Valid) +
            ' AUTH_DATE_BUCKET=' + diagnostics.authDateBucket,
          );
        }
      }),
      previousToken,
      true,
    );
  }

  async login(proof: TelegramProof, previousToken?: string, miniAppSwitch = false) {
    const current = await this.auth.me(previousToken);
    let verifiedPhone: string | undefined;
    if (!miniAppSwitch && proof.phone?.verified === true) {
      try {
        verifiedPhone = phone(proof.phone.number);
      } catch (error) {
        // Unsupported delivery numbers do not invalidate the Telegram login.
        if (!(error instanceof BadRequestException)) throw error;
      }
    }
    // All registration writers serialize by Telegram ID. Unique constraints are
    // the final DB guard; an interrupted transaction never leaves an orphan User.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.db.$transaction(async (db) => {
          const { profile } = proof;
          await db.$executeRaw`SELECT pg_advisory_xact_lock(704003, hashtext(${String(profile.id)}))`;
          if (proof.expiresAt.getTime() <= Date.now())
            throw new UnauthorizedException('TELEGRAM_AUTH_INVALID');
          // OIDC stays one-time. Mini App initData is reverified on every launch
          // and remains usable only within its signed, bounded auth_date window.
          if (!miniAppSwitch) {
            // Bounded indexed cleanup. SKIP LOCKED avoids unrelated login contention.
            await db.$executeRaw`DELETE FROM "TelegramAuthReplay" WHERE "tokenHash" IN
              (SELECT "tokenHash" FROM "TelegramAuthReplay" WHERE "expiresAt" < NOW()
               ORDER BY "expiresAt" LIMIT 100 FOR UPDATE SKIP LOCKED)`;
            const replay = await db.telegramAuthReplay.findUnique({
              where: { tokenHash: proof.tokenHash },
            });
            if (replay) throw new UnauthorizedException('TELEGRAM_AUTH_REPLAY');
            await db.telegramAuthReplay.create({
              data: { tokenHash: proof.tokenHash, expiresAt: proof.expiresAt },
            });
          }
          const telegramUserId = BigInt(profile.id);
          const identity = await db.telegramIdentity.findUnique({
            where: { telegramUserId },
            select: { userId: true },
          });
          if (current && current.id !== identity?.userId && !miniAppSwitch)
            throw new ConflictException('ACCOUNT_LINK_REQUIRED');
          // Use the same phone/account locks as SMS. Never resolve an identity
          // through its claimed phone: an occupied number requires explicit recovery.
          if (verifiedPhone) {
            await db.$executeRaw`SELECT pg_advisory_xact_lock(704002, hashtext(${verifiedPhone}))`;
            if (verifiedPhone === adminPhone())
              throw new UnauthorizedException('TELEGRAM_AUTH_INVALID');
            const owner = await db.user.findUnique({
              where: { phone: verifiedPhone }, select: { id: true },
            });
            if (owner && owner.id !== identity?.userId)
              throw new ConflictException('ACCOUNT_LINK_REQUIRED');
          }
          if (identity) {
            await db.$executeRaw`SELECT pg_advisory_xact_lock(704004, ${identity.userId}::integer)`;
            await db.$queryRaw`SELECT id FROM "User" WHERE id = ${identity.userId} FOR UPDATE`;
            const user = await db.user.findUniqueOrThrow({
              where: { id: identity.userId }, select,
            });
            if (user.role === 'ADMIN' || (user.phone && user.phone === adminPhone()))
              throw new UnauthorizedException('TELEGRAM_AUTH_INVALID');
            // A fresh OIDC proof can recover legacy Telegram-only accounts.
            // Saved phoneVerified metadata alone is never sufficient evidence.
            if (verifiedPhone && (!user.phone || (user.phone === verifiedPhone && !user.verifiedAt)))
              await db.user.update({
                where: { id: user.id },
                data: { phone: verifiedPhone, verifiedAt: new Date() },
              });
          }
          const data = {
            username: profile.username ?? null,
            firstName: profile.first_name ?? null,
            lastName: profile.last_name ?? null,
            ...(profile.photo_url !== undefined ? { photoUrl: profile.photo_url } : {}),
            ...(verifiedPhone ? {
              phoneNumber: verifiedPhone,
              phoneVerified: true,
            } : {}),
          };
          const linked = identity
            ? await db.telegramIdentity.update({
                where: { telegramUserId },
                data,
                include: { user: { select } },
              })
            : await db.telegramIdentity.create({
                data: {
                  telegramUserId,
                  ...data,
                  user: {
                    create: {
                      phone: verifiedPhone ?? null,
                      verifiedAt: verifiedPhone ? new Date() : null,
                      role: 'USER',
                      name:
                        [profile.first_name, profile.last_name]
                          .filter(Boolean)
                          .join(' ') || null,
                    },
                  },
                },
                include: { user: { select } },
              });
          // Customer Telegram authentication never bypasses the admin password channel.
          if (
            linked.user.role === 'ADMIN' ||
            (linked.user.phone !== null && linked.user.phone === adminPhone())
          )
            throw new UnauthorizedException('TELEGRAM_AUTH_INVALID');
          const token = await this.auth.createSession(
            db,
            linked.user.id,
            previousToken,
          );
          return { token, user: authUser(linked.user) };
        });
      } catch (error) {
        // Retry once and re-read identity after a concurrent unique insert.
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'P2002'
        ) {
          if (attempt === 0) continue;
          throw new ConflictException('ACCOUNT_LINK_REQUIRED');
        }
        throw error;
      }
    }
    throw new UnauthorizedException('TELEGRAM_AUTH_INVALID');
  }
}
