import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module.js';
import { AdminGuard } from './admin.guard.js';
import { AuthCtrl } from './auth.ctrl.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { StaffGuard } from './staff.guard.js';

@Module({
  imports: [DbModule],

  controllers: [AuthCtrl],

  providers: [AuthService, AuthGuard, AdminGuard, StaffGuard],

  exports: [AuthService, AuthGuard, AdminGuard, StaffGuard],
})
export class AuthModule {}
