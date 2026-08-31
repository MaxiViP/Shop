import { Module } from '@nestjs/common';
import { AddressModule } from './address/address.module.js';
import { AuthModule } from './auth/auth.module.js';
import { CategoryModule } from './category/category.module.js';
import { HealthCtrl } from './health/health.ctrl.js';
import { OrderModule } from './order/order.module.js';
import { ProductModule } from './product/product.module.js';
import { AdminModule } from './admin/admin.module.js';

@Module({
  imports: [
    AdminModule,
    AddressModule,
    AuthModule,
    CategoryModule,
    OrderModule,
    ProductModule,
  ],
  
  controllers: [HealthCtrl],
})
export class AppModule {}
