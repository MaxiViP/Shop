import {
  Body,
  Controller,
  Get,
  Header,
  Inject,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { SID } from './auth.service.js';
import { sessionCookie } from './session-cookie.js';
import { TelegramAuthGuard } from './telegram-auth.guard.js';
import { TelegramAuthService } from './telegram-auth.service.js';
import { TelegramOidcService } from './telegram-oidc.service.js';
import { PROOF_TTL } from './telegram-init-data.js';

const FLOW =
  process.env.NODE_ENV === 'production'
    ? '__Host-telegram-flow'
    : 'telegram-flow';
const flowCookie = { ...sessionCookie, maxAge: PROOF_TTL * 1000 };

@Controller('auth/telegram')
@UseGuards(TelegramAuthGuard)
export class TelegramAuthCtrl {
  constructor(
    @Inject(TelegramAuthService) private readonly telegram: TelegramAuthService,
    @Inject(TelegramOidcService) private readonly oidc: TelegramOidcService,
  ) {}

  @Get('config')
  @Header('Cache-Control', 'no-store')
  config() {
    return {
      websiteAvailable: this.oidc.available,
      miniAppAvailable: Boolean(process.env.TELEGRAM_BOT_TOKEN),
    };
  }

  @Post('mini-app')
  @Header('Cache-Control', 'no-store')
  async miniApp(
    @Body({
      schema: z.strictObject({ initData: z.string().min(1).max(16384) }),
    })
    body: { initData: string },
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.telegram.miniApp(
      body.initData,
      request.cookies?.[SID],
    );
    response.cookie(SID, result.token, sessionCookie);
    return result.user;
  }

  @Post('start')
  @Header('Cache-Control', 'no-store')
  start(@Res({ passthrough: true }) response: Response) {
    const result = this.oidc.start();
    response.cookie(FLOW, result.cookie, flowCookie);
    return { url: result.url };
  }

  @Get('callback')
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async callback(
    @Query() query: Record<string, unknown>,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    response.clearCookie(FLOW, { ...flowCookie, maxAge: undefined });
    try {
      const data = z
        .object({ code: z.string().max(4096), state: z.string().max(128) })
        .parse(query);
      const proof = await this.oidc.callback(
        data.code,
        data.state,
        request.cookies?.[FLOW] ?? '',
      );
      const result = await this.telegram.login(proof, request.cookies?.[SID]);
      response.cookie(SID, result.token, sessionCookie);
    } catch {
      // Only a server-configured origin is ever used; no client return URL.
      if (!this.oidc.available)
        return response.status(503).send('TELEGRAM_LOGIN_UNAVAILABLE');
      return response.redirect(303, this.oidc.destination(true));
    }
    return response.redirect(303, this.oidc.destination());
  }
}
