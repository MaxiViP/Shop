import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module.js';
import { CategoryCtrl } from './category.ctrl.js';
import { CategoryService } from './category.service.js';

@Module({
  imports: [DbModule],
  controllers: [CategoryCtrl],
  providers: [CategoryService],
})
export class CategoryModule {}
