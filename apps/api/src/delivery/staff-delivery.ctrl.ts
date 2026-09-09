import {
  BadGatewayException,
  Controller,
  Get,
  HttpException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard.js';
import { StaffGuard } from '../auth/staff.guard.js';
import { DeliveryService } from './delivery.service.js';
import type { AuthRequest } from '../auth/auth.guard.js';
import { StaffService } from '../staff/staff.service.js';

const idSchema = z.coerce.number().int().positive();

@Controller('staff/orders')
@UseGuards(AuthGuard, StaffGuard)
export class StaffDeliveryCtrl {
  constructor(
    private readonly delivery: DeliveryService,
    private readonly staff: StaffService,
  ) {}

  @Post(':id/delivery/yandex/confirm')
  async confirm(
    @Param('id', { schema: idSchema }) id: number,
    @Req() request: AuthRequest,
  ) {
    // Record receipt of real money first. Provider failure must never undo PAID.
    await this.staff.confirmPayment(id, request.user.id, 'DELIVERY');
    try {
      return await this.delivery.order(id);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new BadGatewayException(
        'Оплата получена. Не удалось оформить доставку; повторите оформление.',
      );
    }
  }

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
