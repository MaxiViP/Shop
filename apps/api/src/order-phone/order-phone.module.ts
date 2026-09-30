import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../db/db.module.js';
import { OrderPhoneCtrl } from './order-phone.ctrl.js';
import { OrderPhoneService } from './order-phone.service.js';

@Module({
  imports: [AuthModule, DbModule],
  controllers: [OrderPhoneCtrl],
  providers: [OrderPhoneService],
})
export class OrderPhoneModule {}
