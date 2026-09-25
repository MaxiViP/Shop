import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module.js';
import { OrderModule } from '../order/order.module.js';
import { CartService } from './cart.service.js';
@Module({
  imports: [DbModule, OrderModule],
  providers: [CartService],
  exports: [CartService],
})
export class CartModule {}
