import {
  Body,
  Controller,
  Get,
  Header,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { AdminLoginGuard } from './admin-login.guard.js';
import { MethodGuard } from './method.guard.js';
import { OtpCodeGuard, OtpLoginGuard } from './otp.guard.js';
import type { Request, Response } from 'express';
import { GID } from '../common/guest.js';

import { AuthService, SID } from './auth.service.js';
import { sessionCookie } from './session-cookie.js';

@Controller('auth')
export class AuthCtrl {
  constructor(private readonly auth: AuthService) {}

  @Post('method')
  @Header('Cache-Control', 'no-store')
  @UseGuards(MethodGuard)
  method(
    @Body({
      schema: z.strictObject({ phone: z.string().trim().min(1).max(40) }),
    })
    body: {
      phone: string;
    },
  ) {
    return this.auth.method(body.phone);
  }

  @Post('admin/login')
  @UseGuards(AdminLoginGuard)
  async adminLogin(
    @Body({
      schema: z.strictObject({
        phone: z.string().max(40),
        password: z.string().max(1024),
      }),
    })
    body: { phone: string; password: string },
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.auth.adminLogin(body.phone, body.password);
    response.cookie(SID, result.token, sessionCookie);
    return result.user;
  }

  @Post('code')
  @UseGuards(OtpCodeGuard)
  code(
    @Body({
      schema: z.strictObject({ phone: z.string().trim().min(1).max(40) }),
    })
    body: {
      phone: string;
    },
  ) {
    return this.auth.code(body.phone);
  }

  @Post('login')
  @UseGuards(OtpLoginGuard)
  async login(
    @Req() request: Request,

    @Body({
      schema: z.strictObject({
        phone: z.string().trim().min(1).max(40),
        code: z.string().regex(/^\d{6}$/),
      }),
    })
    body: {
      phone: string;
      code: string;
    },

    @Res({ passthrough: true })
    response: Response,
  ) {
    const result = await this.auth.login(
      body.phone,
      body.code,
      request.cookies?.[GID],
      (await this.auth.me(request.cookies?.[SID]))?.id,
      request.cookies?.[SID],
    );

    response.cookie(SID, result.token, sessionCookie);

    return result.user;
  }

  @Get('me')
  @Header('Cache-Control', 'no-store')
  me(@Req() request: Request) {
    return this.auth.me(request.cookies?.[SID]);
  }

  @Post('logout')
  async logout(
    @Req() request: Request,

    @Res({ passthrough: true })
    response: Response,
  ) {
    await this.auth.logout(request.cookies?.[SID]);

    response.clearCookie(SID, { ...sessionCookie, maxAge: undefined });

    return { ok: true };
  }
}
