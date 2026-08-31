import { Body, Controller, Get, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { GID } from '../common/guest.js';

import { AuthService, SID } from './auth.service.js';
const prod = process.env.NODE_ENV === 'production';

const maxAge = 30 * 24 * 60 * 60 * 1000;

@Controller('auth')
export class AuthCtrl {
  constructor(private readonly auth: AuthService) {}

  @Post('code')
  code(@Body() body: { phone?: string }) {
    return this.auth.code(body.phone);
  }

  @Post('login')
  async login(
    @Req() request: Request,

    @Body()
    body: {
      phone?: string;
      code?: string;
    },

    @Res({ passthrough: true })
    response: Response,
  ) {
    const result = await this.auth.login(
      body.phone,
      body.code,
      request.cookies?.[GID],
    );

    response.cookie(SID, result.token, {
      httpOnly: true,
      secure: prod,
      sameSite: 'lax',
      path: '/',
      maxAge,
    });

    return result.user;
  }

  @Get('me')
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

    response.clearCookie(SID, {
      httpOnly: true,
      secure: prod,
      sameSite: 'lax',
      path: '/',
    });

    return { ok: true };
  }
}
