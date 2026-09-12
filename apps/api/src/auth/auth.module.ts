import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module.js';
import { AdminGuard } from './admin.guard.js';
import { AuthCtrl } from './auth.ctrl.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { StaffGuard } from './staff.guard.js';
import { AdminLoginGuard } from './admin-login.guard.js';
import { MethodGuard } from './method.guard.js';
import { OtpCodeGuard, OtpLoginGuard } from './otp.guard.js';

@Module({
  imports: [DbModule],

  controllers: [AuthCtrl],

  providers: [
    AuthService,
    AuthGuard,
    AdminGuard,
    StaffGuard,
    AdminLoginGuard,
    MethodGuard,
    OtpCodeGuard,
    OtpLoginGuard,
  ],

  exports: [AuthService, AuthGuard, AdminGuard, StaffGuard],
})
export class AuthModule {}
