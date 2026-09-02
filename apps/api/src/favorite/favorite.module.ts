import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../db/db.module.js';
import { FavoriteCtrl } from './favorite.ctrl.js';
import { FavoriteService } from './favorite.service.js';

@Module({
  imports: [AuthModule, DbModule],
  controllers: [FavoriteCtrl],
  providers: [FavoriteService],
})
export class FavoriteModule {}
