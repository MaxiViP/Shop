import {
  Injectable,
  HttpException,
  Logger,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Observable, catchError, throwError } from 'rxjs';
import { randomUUID } from 'node:crypto';
import type { AuthRequest } from '../auth/auth.guard.js';
import { AuthService, SID } from '../auth/auth.service.js';
import { adminPhone } from '../auth/admin.config.js';
import { adminActivity } from './activity-context.js';
import { EventsService } from './events.service.js';
import { GID } from '../common/guest.js';

@Injectable()
export class AdminActivityInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AdminActivityInterceptor.name);
  constructor(
    private readonly auth: AuthService,
    private readonly events: EventsService,
  ) {}
  async intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method))
      return next.handle();
    const user =
      request.user ??
      (request.cookies?.[SID]
        ? await this.auth.me(request.cookies[SID])
        : null);
    const requestId = randomUUID();
    return new Observable((subscriber) =>
      adminActivity.run(
        {
          actorId: user?.id ?? 0,
          source: 'WEB',
          requestId,
          role: user?.role ?? (request.cookies?.[GID] ? 'GUEST' : 'SYSTEM'),
          notifyOwner: user?.role === 'ADMIN' && user.phone !== adminPhone(),
        },
        () =>
          next
            .handle()
            .pipe(
              catchError((error: unknown) => {
                if (
                  !(error instanceof HttpException) ||
                  error.getStatus() >= 500
                )
                  void this.events
                    .failure(
                      requestId,
                      user,
                      /\/(auth|admin\/(users|products\/service-fee|settings))(\/|$)/.test(request.path),
                    )
                    .catch(() =>
                      this.logger.warn(
                        'Failed to record an unsuccessful operation',
                      ),
                    );
                return throwError(() => error);
              }),
            )
            .subscribe(subscriber),
      ),
    );
  }
}
