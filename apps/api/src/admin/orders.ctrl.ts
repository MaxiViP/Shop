import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard.js';
import { idSchema } from './schema.js';
import { ordersQuerySchema, type OrdersQuery } from './orders.schema.js';
import { AdminOrdersService } from './orders.service.js';
@Controller('admin/orders')
@UseGuards(AdminGuard)
export class AdminOrdersCtrl {
  constructor(private readonly orders: AdminOrdersService) {}
  @Get() list(@Query({ schema: ordersQuerySchema }) query: OrdersQuery) {
    return this.orders.list(query);
  }
  @Get(':id') get(@Param('id', { schema: idSchema }) id: number) {
    return this.orders.get(id);
  }
}
