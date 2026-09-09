import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../db/db.module.js';
import { OrderCtrl } from './order.ctrl.js';
import { OrderService } from './order.service.js';
import { CoordinationService } from './coordination.service.js';
import { CustomerCoordinationCtrl, StaffCoordinationCtrl } from './coordination.ctrl.js';
import { NotificationService, OrderSmsProvider, DisabledOrderSms } from './notification.service.js';

@Module({
  imports: [AuthModule, DbModule],

  controllers: [OrderCtrl, CustomerCoordinationCtrl, StaffCoordinationCtrl],
  providers: [OrderService, CoordinationService, NotificationService, { provide: OrderSmsProvider, useClass: DisabledOrderSms }],
  exports: [NotificationService],
})
export class OrderModule {}
