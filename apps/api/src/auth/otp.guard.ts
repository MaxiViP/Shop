import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import { AttemptLimit } from './attempt-limit.js';
import { clientIp } from './proxy.js';

@Injectable()
export class OtpCodeGuard implements CanActivate {
  private readonly limit = new AttemptLimit(10, 500, 10);
  canActivate(context: ExecutionContext) {
    this.limit.check(clientIp(context.switchToHttp().getRequest<Request>()));
    return true;
  }
}

@Injectable()
export class OtpLoginGuard implements CanActivate {
  private readonly limit = new AttemptLimit(30, 1000, 5);
  canActivate(context: ExecutionContext) {
    this.limit.check(clientIp(context.switchToHttp().getRequest<Request>()));
    return true;
  }
}
