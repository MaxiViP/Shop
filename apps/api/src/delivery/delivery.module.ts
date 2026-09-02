import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../db/db.module.js';
import { DeliveryCtrl } from './delivery.ctrl.js';
import { DeliveryService } from './delivery.service.js';
import { StaffDeliveryCtrl } from './staff-delivery.ctrl.js';
import { YandexService } from './yandex.service.js';
import { YandexCallbackCtrl } from './yandex-callback.ctrl.js';
import { YandexSyncService } from './yandex-sync.service.js';

@Module({
  imports: [AuthModule, DbModule],
  controllers: [DeliveryCtrl, StaffDeliveryCtrl, YandexCallbackCtrl],
  providers: [DeliveryService, YandexService, YandexSyncService],
})
export class DeliveryModule {}
