import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../db/db.module.js';
import { AdminActivityInterceptor } from './activity.interceptor.js';
import { AdminActivityService } from './activity.service.js';
import { EventsCtrl } from './events.ctrl.js';
import { EventsService } from './events.service.js';
import { AdminActivityCtrl } from './activity.ctrl.js';
@Module({
  imports: [DbModule, AuthModule],
  controllers: [AdminActivityCtrl, EventsCtrl],
  providers: [
    AdminActivityService,
    EventsService,
    { provide: APP_INTERCEPTOR, useClass: AdminActivityInterceptor },
  ],
})
export class AdminActivityModule {}
