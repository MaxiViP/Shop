import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../db/db.module.js';
import { CartCtrl } from './cart.ctrl.js';
import { OrderModule } from '../order/order.module.js';
import { CartService } from './cart.service.js';
@Module({
  imports: [AuthModule, DbModule, OrderModule],
  controllers: [CartCtrl],
  providers: [CartService],
  exports: [CartService],
})
export class CartModule {}
