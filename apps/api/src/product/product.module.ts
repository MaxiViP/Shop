import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module.js';
import { ProductCtrl } from './product.ctrl.js';
import { ProductService } from './product.service.js';
import { ProductImageModule } from './image.module.js';

@Module({
  imports: [DbModule, ProductImageModule],
  controllers: [ProductCtrl],
  providers: [ProductService],
})
export class ProductModule {}
