import {
  ForbiddenException,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import { allowedOrigin } from './admin.config.js';
import { AttemptLimit } from './attempt-limit.js';
import { clientIp } from './proxy.js';

@Injectable()
export class TelegramAuthGuard implements CanActivate {
  private readonly limit = new AttemptLimit(30, 1000, 5);
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request>();
    this.limit.check(clientIp(request));
    // Callback GET is bound to an encrypted HttpOnly state cookie.
    // All auth POSTs require an explicitly trusted browser origin.
    if (
      request.method === 'POST' &&
      (!request.headers.origin || !allowedOrigin(request.headers.origin))
    )
      throw new ForbiddenException();
    return true;
  }
}
