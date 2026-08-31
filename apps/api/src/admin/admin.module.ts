import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../db/db.module.js';
import { AdminCtrl } from './admin.ctrl.js';
import { AdminService } from './admin.service.js';

@Module({
  imports: [AuthModule, DbModule],

  controllers: [AdminCtrl],
  providers: [AdminService],
})
export class AdminModule {}
