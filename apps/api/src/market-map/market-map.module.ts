import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../db/db.module.js';
import { AdminMarketMapCtrl, AdminMarketLayoutCtrl } from '../admin/market-map.ctrl.js';
import { MarketMapCtrl } from './market-map.ctrl.js';
import { MarketMapService } from './market-map.service.js';

@Module({
  imports: [AuthModule, DbModule],
  controllers: [MarketMapCtrl, AdminMarketMapCtrl, AdminMarketLayoutCtrl],
  providers: [MarketMapService],
})
export class MarketMapModule {}
