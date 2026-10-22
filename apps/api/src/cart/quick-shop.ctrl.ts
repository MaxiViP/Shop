import { Body, Controller, ForbiddenException, Get, Header, Post, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard, type AuthRequest } from '../auth/auth.guard.js';
import { QuickShopService } from './quick-shop.service.js';

export const repeatCartSchema = z.object({
  revision: z.uuid(), orderId: z.number().int().positive().max(2_147_483_647).optional(),
});

@Controller('cart')
@UseGuards(AuthGuard)
export class QuickShopCtrl {
  constructor(private readonly quick: QuickShopService) {}

  private owner(request: AuthRequest) {
    if (request.user.role !== 'USER') throw new ForbiddenException('Корзина доступна только покупателю');
    return request.user.id;
  }

  @Get('quick-shop')
  @Header('Cache-Control', 'private, no-store')
  get(@Req() request: AuthRequest) { return this.quick.get(this.owner(request)); }

  @Post('repeat')
  @Header('Cache-Control', 'private, no-store')
  repeat(@Req() request: AuthRequest, @Body({ schema: repeatCartSchema }) body: z.infer<typeof repeatCartSchema>) {
    return this.quick.repeat(this.owner(request), body.revision, body.orderId);
  }
}
