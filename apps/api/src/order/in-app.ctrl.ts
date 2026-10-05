import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { AuthService, SID } from '../auth/auth.service.js';
import { GID } from '../common/guest.js';
import { InAppService } from './in-app.service.js';

const query = z.strictObject({ limit: z.coerce.number().int().min(1).max(20).default(2) });
const seen = z.strictObject({ ids: z.array(z.number().int().positive()).min(1).max(50) });

@Controller('notifications')
export class InAppCtrl {
  constructor(private readonly feed: InAppService, private readonly auth: AuthService) {}
  @Get()
  async list(@Req() request: Request, @Query({ schema: query }) input: z.infer<typeof query>) {
    return this.feed.list(await this.auth.me(request.cookies?.[SID]), request.cookies?.[GID], input.limit);
  }
  @Post('seen')
  async acknowledge(@Req() request: Request, @Body({ schema: seen }) input: z.infer<typeof seen>) {
    return this.feed.seen(await this.auth.me(request.cookies?.[SID]), request.cookies?.[GID], input.ids);
  }
}
