import { createHash, timingSafeEqual } from 'node:crypto';
import { ForbiddenException, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { staffWebhookSecret, validWebhookSecret } from './bot-config.js';

export function matchesWebhookSecret(header: unknown, secret: string): boolean {
  if (!validWebhookSecret(secret) || typeof header !== 'string' || header.length > 256) return false;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(header), digest(secret));
}

@Injectable()
export class TelegramWebhookGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const header = context.switchToHttp().getRequest<Request>().headers['x-telegram-bot-api-secret-token'];
    if (!matchesWebhookSecret(header, staffWebhookSecret())) throw new ForbiddenException('Forbidden');
    return true;
  }
}
