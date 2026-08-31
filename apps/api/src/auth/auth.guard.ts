import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthService, SID } from './auth.service.js';

export type AuthRequest = Request & {
  user: {
    id: number;
    phone: string;
    name: string | null;
    role: 'USER' | 'ADMIN';
    verifiedAt: Date | null;
  };
};

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthRequest>();

    const user = await this.auth.me(request.cookies?.[SID]);

    if (!user) {
      throw new UnauthorizedException();
    }

    request.user = user;

    return true;
  }
}
