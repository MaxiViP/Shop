import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module.js';
import { ProductCtrl } from './product.ctrl.js';
import { ProductService } from './product.service.js';

@Module({
  imports: [DbModule],
  controllers: [ProductCtrl],
  providers: [ProductService],
})
export class ProductModule {}
