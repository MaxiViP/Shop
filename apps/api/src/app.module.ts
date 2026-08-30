import { Module } from '@nestjs/common';
import { HealthCtrl } from './health/health.ctrl.js';
import { ProductModule } from './product/product.module.js';

@Module({
  imports: [ProductModule],
  controllers: [HealthCtrl],
})
export class AppModule {}
