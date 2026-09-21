import { createHash, timingSafeEqual } from 'node:crypto';
import { ForbiddenException, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

@Injectable()
export class TelegramWebhookGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
    const header = context.switchToHttp().getRequest<Request>().headers['x-telegram-bot-api-secret-token'];
    if (!secret || secret.length > 256 || /[^A-Za-z0-9_-]/.test(secret) || typeof header !== 'string' || header.length > 256)
      throw new ForbiddenException('Forbidden');
    const digest = (value: string) => createHash('sha256').update(value).digest();
    if (!timingSafeEqual(digest(header), digest(secret))) throw new ForbiddenException('Forbidden');
    return true;
  }
}
