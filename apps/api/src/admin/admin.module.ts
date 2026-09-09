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
import { SettingsCtrl } from './settings.ctrl.js';
import { SettingsService } from './settings.service.js';
@Module({
  imports: [AuthModule, DbModule],
  controllers: [
    AdminProductsCtrl,
    AdminCategoriesCtrl,
    AdminUsersCtrl,
    SettingsCtrl,
  ],
  providers: [
    AdminProductsService,
    AdminCategoriesService,
    AdminUsersService,
    ImagesService,
    SettingsService,
  ],
})
export class AdminModule {}
