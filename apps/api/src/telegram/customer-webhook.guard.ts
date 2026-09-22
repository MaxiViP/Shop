import { ForbiddenException, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { customerWebhookReady, customerWebhookSecret } from './bot-config.js';
import { matchesWebhookSecret } from './telegram-webhook.guard.js';

@Injectable()
export class CustomerWebhookGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const header = context.switchToHttp().getRequest<Request>().headers['x-telegram-bot-api-secret-token'];
    if (!customerWebhookReady() || !matchesWebhookSecret(header, customerWebhookSecret()))
      throw new ForbiddenException('Forbidden');
    return true;
  }
}
