import { Module } from '@nestjs/common';
import { AddressModule } from './address/address.module.js';
import { AuthModule } from './auth/auth.module.js';
import { CategoryModule } from './category/category.module.js';
import { DeliveryModule } from './delivery/delivery.module.js';
import { FavoriteModule } from './favorite/favorite.module.js';
import { HealthCtrl } from './health/health.ctrl.js';
import { OrderModule } from './order/order.module.js';
import { ProductModule } from './product/product.module.js';
import { StaffModule } from './staff/staff.module.js';

@Module({
  imports: [
    StaffModule,
    AddressModule,
    AuthModule,
    CategoryModule,
    DeliveryModule,
    FavoriteModule,
    OrderModule,
    ProductModule,
  ],

  controllers: [HealthCtrl],
})
export class AppModule {}
