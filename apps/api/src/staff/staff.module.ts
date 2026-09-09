import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../db/db.module.js';
import { StaffCtrl } from './staff.ctrl.js';
import { StaffService } from './staff.service.js';
import { OrderModule } from '../order/order.module.js';

@Module({
  exports: [StaffService],
  imports: [AuthModule, DbModule, OrderModule],

  controllers: [StaffCtrl],
  providers: [StaffService],
})
export class StaffModule {}
