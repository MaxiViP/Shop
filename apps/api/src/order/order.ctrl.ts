import { Body, Controller, Get, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService, SID } from '../auth/auth.service.js';
import { GID, GUEST_TTL } from '../common/guest.js';
import { z } from 'zod';
import { reportSchema } from './payment.js';
import { OrderService } from './order.service.js';
import { orderSchema, type OrderInput } from './schema.js';

const prod = process.env.NODE_ENV === 'production';

@Controller('orders')
export class OrderCtrl {
  constructor(
    private readonly order: OrderService,
    private readonly auth: AuthService,
  ) {}

  @Post()
  async create(
    @Req() request: Request,

    @Res({
      passthrough: true,
    })
    response: Response,

    @Body({
      schema: orderSchema,
    })
    body: OrderInput,
  ) {
    const user = await this.auth.me(request.cookies?.[SID]);

    const result = await this.order.create(
      user?.id ?? null,
      request.cookies?.[GID],
      body,
    );

    if (result.guestToken) {
      response.cookie(GID, result.guestToken, {
        httpOnly: true,
        secure: prod,
        sameSite: 'lax',
        path: '/',
        maxAge: GUEST_TTL,
      });
    }

    return result.order;
  }

  @Get()
  async list(@Req() request: Request) {
    const user = await this.auth.me(request.cookies?.[SID]);

    return this.order.list(user?.id ?? null, request.cookies?.[GID]);
  }

  @Get('unread')
  async unread(@Req() request: Request) {
    const user = await this.auth.me(request.cookies?.[SID]);
    return this.order.unread(user?.id ?? null, request.cookies?.[GID]);
  }

  @Get(':publicId')
  async get(
    @Req() request: Request,

    @Param('publicId')
    publicId: string,
  ) {
    const user = await this.auth.me(request.cookies?.[SID]);

    return this.order.get(publicId, user?.id ?? null, request.cookies?.[GID]);
  }

  @Post(':publicId/payment/report')
  // Legacy clients only. The current storefront never reports a transfer;
  // this owner-protected transition still cannot confirm receipt of money.
  async reportPayment(
    @Req() request: Request,
    @Param('publicId', { schema: z.string().uuid() }) publicId: string,
    @Body({ schema: reportSchema }) body: z.infer<typeof reportSchema>,
  ) {
    const user = await this.auth.me(request.cookies?.[SID]);
    return this.order.reportPayment(
      publicId,
      user?.id ?? null,
      request.cookies?.[GID],
      body.method,
    );
  }
}
