import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../db/db.module.js';
import { FavoriteCtrl } from './favorite.ctrl.js';
import { FavoriteService } from './favorite.service.js';
import { ProductImageModule } from '../product/image.module.js';

@Module({
  imports: [AuthModule, DbModule, ProductImageModule],
  controllers: [FavoriteCtrl],
  providers: [FavoriteService],
})
export class FavoriteModule {}
