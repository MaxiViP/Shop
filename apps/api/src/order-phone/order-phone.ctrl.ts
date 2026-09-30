import {
  Body, Controller, Delete, ForbiddenException, Get, Param, Patch, Post, Req, UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard, type AuthRequest } from '../auth/auth.guard.js';
import { OrderPhoneService } from './order-phone.service.js';

const idSchema = z.coerce.number().int().positive();
const phoneSchema = z.object({ phone: z.string().min(1).max(64) });
const primarySchema = z.object({ phone: z.string().min(1).max(64).nullable() });

@Controller('order-phones')
@UseGuards(AuthGuard)
export class OrderPhoneCtrl {
  constructor(private readonly phones: OrderPhoneService) {}

  private owner(request: AuthRequest) {
    if (request.user.role !== 'USER')
      throw new ForbiddenException('Телефоны для заказов доступны только покупателю');
    return request.user.id;
  }

  @Get()
  list(@Req() request: AuthRequest) {
    return this.phones.list(this.owner(request));
  }

  @Post()
  create(@Req() request: AuthRequest, @Body({ schema: phoneSchema }) body: z.infer<typeof phoneSchema>) {
    return this.phones.create(this.owner(request), body.phone);
  }

  @Patch('primary')
  primary(@Req() request: AuthRequest, @Body({ schema: primarySchema }) body: z.infer<typeof primarySchema>) {
    return this.phones.setPrimary(this.owner(request), body.phone);
  }

  @Patch(':id')
  update(
    @Req() request: AuthRequest,
    @Param('id', { schema: idSchema }) id: number,
    @Body({ schema: phoneSchema }) body: z.infer<typeof phoneSchema>,
  ) {
    return this.phones.update(this.owner(request), id, body.phone);
  }

  @Delete(':id')
  remove(@Req() request: AuthRequest, @Param('id', { schema: idSchema }) id: number) {
    return this.phones.remove(this.owner(request), id);
  }
}
