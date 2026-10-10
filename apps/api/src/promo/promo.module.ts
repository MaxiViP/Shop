import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../db/db.module.js';
import { PromoCtrl } from './promo.ctrl.js';
import { PromoService } from './promo.service.js';
@Module({ imports: [AuthModule, DbModule], controllers: [PromoCtrl], providers: [PromoService], exports: [PromoService] })
export class PromoModule {}
