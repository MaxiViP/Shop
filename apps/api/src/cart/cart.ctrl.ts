import { Body, Controller, ForbiddenException, Get, Post, Req, UseGuards } from '@nestjs/common';
import type { AuthRequest } from '../auth/auth.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { CartService } from './cart.service.js';
import {
  cartChangeSchema,
  cartCheckoutSchema,
  cartMergeSchema,
  type CartChangeInput,
  type CartCheckoutInput,
  type CartMergeInput,
} from './schema.js';

@Controller('cart')
@UseGuards(AuthGuard)
export class CartCtrl {
  constructor(private readonly cart: CartService) {}

  private owner(request: AuthRequest) {
    if (request.user.role !== 'USER')
      throw new ForbiddenException('Корзина доступна только покупателю');
    return request.user.id;
  }

  @Get()
  get(@Req() request: AuthRequest) {
    return this.cart.get(this.owner(request));
  }

  @Post('change')
  change(
    @Req() request: AuthRequest,
    @Body({ schema: cartChangeSchema }) body: CartChangeInput,
  ) {
    return this.cart.change(this.owner(request), body.revision, body);
  }

  @Post('merge')
  merge(
    @Req() request: AuthRequest,
    @Body({ schema: cartMergeSchema }) body: CartMergeInput,
  ) {
    return this.cart.merge(this.owner(request), body.revision, body.items);
  }

  @Post('checkout')
  checkout(
    @Req() request: AuthRequest,
    @Body({ schema: cartCheckoutSchema }) body: CartCheckoutInput,
  ) {
    const { revision, ...data } = body;
    return this.cart.checkout(this.owner(request), revision, data);
  }
}
