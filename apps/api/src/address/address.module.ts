import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../db/db.module.js';
import { AddressCtrl } from './address.ctrl.js';
import { AddressService } from './address.service.js';

@Module({
  imports: [AuthModule, DbModule],

  controllers: [AddressCtrl],
  providers: [AddressService],
})
export class AddressModule {}
