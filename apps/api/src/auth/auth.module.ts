import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module.js';
import { AdminGuard } from './admin.guard.js';
import { AuthCtrl } from './auth.ctrl.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';

@Module({
  imports: [DbModule],

  controllers: [AuthCtrl],

  providers: [AuthService, AuthGuard, AdminGuard],

  exports: [AuthService, AuthGuard, AdminGuard],
})
export class AuthModule {}
