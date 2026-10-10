import { Body, ConflictException, Controller, Get, Param, Patch, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService, SID } from '../auth/auth.service.js';
import { GID, GUEST_TTL } from '../common/guest.js';
import { z } from 'zod';
import { reportSchema } from './payment.js';
import { OrderService } from './order.service.js';
import { orderSchema, type OrderInput } from './schema.js';
import { quoteSchema, type QuoteInput } from './cart-quote.js';

const prod = process.env.NODE_ENV === 'production';
const scheduleSchema = z.strictObject({ fulfillmentMode: z.enum(['ASAP', 'SCHEDULED']),
  scheduledFor: z.string().datetime().optional() }).superRefine((data, ctx) => {
    if ((data.fulfillmentMode === 'SCHEDULED') !== Boolean(data.scheduledFor))
      ctx.addIssue({ code: 'custom', path: ['scheduledFor'], message: 'Выберите время подготовки' });
  });

@Controller('orders')
export class OrderCtrl {
  constructor(
    private readonly order: OrderService,
    private readonly auth: AuthService,
  ) {}

  @Post('quote')
  async quote(@Body({ schema: quoteSchema }) body: QuoteInput, @Req() request: Request) {
    const user = body.promoCodeId ? await this.auth.me(request.cookies?.[SID]) : null;
    return this.order.quote(body, undefined, user?.id ?? null);
  }

  @Get('queue/offer')
  offer() { return this.order.offer(); }

  @Post('checkout-session')
  async checkoutSession(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const result = await this.order.checkoutSession(request.cookies?.[GID]);
    if (result.token) response.cookie(GID, result.token, {
      httpOnly: true, secure: prod, sameSite: 'lax', path: '/', maxAge: GUEST_TTL,
    });
    return { ready: true };
  }

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
    if (user?.role === 'USER')
      throw new ConflictException({
        code: 'SHARED_CART_REQUIRED',
        message: 'Обновите корзину и оформите заказ из общей корзины.',
      });

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

  @Get(':publicId/queue')
  async queue(@Req() request: Request, @Param('publicId', { schema: z.uuid() }) publicId: string) {
    const user = await this.auth.me(request.cookies?.[SID]);
    return this.order.queueFor(publicId, user?.id ?? null, request.cookies?.[GID]);
  }

  @Patch(':publicId/fulfillment')
  async schedule(@Req() request: Request, @Param('publicId', { schema: z.uuid() }) publicId: string,
    @Body({ schema: scheduleSchema }) body: z.infer<typeof scheduleSchema>) {
    const user = await this.auth.me(request.cookies?.[SID]);
    return this.order.schedule(publicId, user?.id ?? null, request.cookies?.[GID],
      body.fulfillmentMode, body.scheduledFor);
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
