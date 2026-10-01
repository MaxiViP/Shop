import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../db/db.module.js';
import { AdminProductsCtrl } from './products.ctrl.js';
import { AdminProductsService } from './products.service.js';
import { AdminCategoriesCtrl } from './categories.ctrl.js';
import { AdminCategoriesService } from './categories.service.js';
import { AdminUsersCtrl } from './users.ctrl.js';
import { AdminUsersService } from './users.service.js';
import { ImagesService } from './images.service.js';
import { SettingsCtrl, PublicSettingsCtrl, ExtraLimitsCtrl } from './settings.ctrl.js';
import { SettingsService } from './settings.service.js';
import { ScheduleCtrl, ShopStatusCtrl } from './schedule.ctrl.js';
import { ScheduleService } from './schedule.service.js';
import { StaffModule } from '../staff/staff.module.js';
import { AdminOrdersCtrl } from './orders.ctrl.js';
import { AdminOrdersService } from './orders.service.js';
import { FinanceCtrl, PayoutsCtrl } from './finance.ctrl.js';
import { FinanceService } from './finance.service.js';
import { PayoutsService } from './payouts.service.js';
import { DashboardCtrl } from './dashboard.ctrl.js';
import { DashboardService } from './dashboard.service.js';
@Module({
  imports: [AuthModule, DbModule, StaffModule],
  controllers: [
    AdminProductsCtrl,
    AdminCategoriesCtrl,
    AdminUsersCtrl,
    SettingsCtrl,
    PublicSettingsCtrl,
    ExtraLimitsCtrl,
    ScheduleCtrl,
    ShopStatusCtrl,
    AdminOrdersCtrl,
    FinanceCtrl,
    PayoutsCtrl,
    DashboardCtrl,
  ],
  providers: [
    AdminProductsService,
    AdminCategoriesService,
    AdminUsersService,
    ImagesService,
    SettingsService,
    ScheduleService,
    AdminOrdersService,
    FinanceService,
    PayoutsService,
    DashboardService,
  ],
})
export class AdminModule {}
