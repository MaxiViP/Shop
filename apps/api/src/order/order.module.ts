import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../db/db.module.js';
import { TelegramModule } from '../telegram/telegram.module.js';
import { CustomerNotificationService } from '../telegram/customer-notification.service.js';
import { OrderCtrl } from './order.ctrl.js';
import { OrderService } from './order.service.js';
import { InAppCtrl } from './in-app.ctrl.js';
import { InAppService } from './in-app.service.js';
import { CoordinationService } from './coordination.service.js';
import { ChatImagesService } from './chat-images.service.js';
import { ChatTempCleanupInterceptor } from './chat-temp.interceptor.js';
import { ChatCleanupService } from './chat-cleanup.service.js';
import { CustomerCoordinationCtrl, StaffCoordinationCtrl } from './coordination.ctrl.js';
import { NotificationService, OrderSmsProvider, DisabledOrderSms } from './notification.service.js';

@Module({
  imports: [AuthModule, DbModule, TelegramModule],

  controllers: [OrderCtrl, CustomerCoordinationCtrl, StaffCoordinationCtrl, InAppCtrl],
  providers: [InAppService, OrderService, CoordinationService, ChatImagesService, ChatTempCleanupInterceptor, ChatCleanupService, NotificationService, CustomerNotificationService, { provide: OrderSmsProvider, useClass: DisabledOrderSms }],
  exports: [NotificationService, OrderService, CoordinationService],
})
export class OrderModule {}
