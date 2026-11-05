import { Module } from '@nestjs/common';
import { StaffModule } from '../staff/staff.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../db/db.module.js';
import { DeliveryCtrl } from './delivery.ctrl.js';
import { DeliveryService } from './delivery.service.js';
import { StaffDeliveryCtrl } from './staff-delivery.ctrl.js';
import { YandexService } from './yandex.service.js';
import { YandexCallbackCtrl } from './yandex-callback.ctrl.js';
import { YandexSyncService } from './yandex-sync.service.js';
import { EstimateCtrl } from './estimate.ctrl.js';
import { EstimateService } from './estimate.service.js';

@Module({
  imports: [AuthModule, DbModule, StaffModule],
  controllers: [
    DeliveryCtrl,
    StaffDeliveryCtrl,
    YandexCallbackCtrl,
    EstimateCtrl,
  ],
  providers: [
    DeliveryService,
    YandexService,
    YandexSyncService,
    EstimateService,
  ],
})
export class DeliveryModule {}
