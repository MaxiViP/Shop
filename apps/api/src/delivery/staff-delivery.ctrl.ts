import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard.js';
import { StaffGuard } from '../auth/staff.guard.js';
import { DeliveryService } from './delivery.service.js';

const idSchema = z.coerce.number().int().positive();

@Controller('staff/orders')
@UseGuards(AuthGuard, StaffGuard)
export class StaffDeliveryCtrl {
  constructor(private readonly delivery: DeliveryService) {}

  @Get('delivery/yandex/config')
  config() {
    return this.delivery.config();
  }

  @Post(':id/delivery/yandex/quote')
  quote(@Param('id', { schema: idSchema }) id: number) {
    return this.delivery.quote(id);
  }

  @Post(':id/delivery/yandex/order')
  order(@Param('id', { schema: idSchema }) id: number) {
    return this.delivery.order(id);
  }

  @Post(':id/delivery/yandex/sync')
  sync(@Param('id', { schema: idSchema }) id: number) {
    return this.delivery.syncOrder(id);
  }
}
