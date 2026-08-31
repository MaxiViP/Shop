import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../db/db.module.js';
import { OrderCtrl } from './order.ctrl.js';
import { OrderService } from './order.service.js';

@Module({
  imports: [AuthModule, DbModule],

  controllers: [OrderCtrl],
  providers: [OrderService],
})
export class OrderModule {}
