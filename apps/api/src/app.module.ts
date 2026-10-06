import { Module } from '@nestjs/common';
import { TelegramWebhookModule } from './telegram/telegram-webhook.module.js';
import { AdminModule } from './admin/admin.module.js';
import { AddressModule } from './address/address.module.js';
import { AuthModule } from './auth/auth.module.js';
import { CategoryModule } from './category/category.module.js';
import { CartModule } from './cart/cart.module.js';
import { DeliveryModule } from './delivery/delivery.module.js';
import { FavoriteModule } from './favorite/favorite.module.js';
import { HealthCtrl } from './health/health.ctrl.js';
import { OrderModule } from './order/order.module.js';
import { OrderPhoneModule } from './order-phone/order-phone.module.js';
import { ProductModule } from './product/product.module.js';
import { StaffModule } from './staff/staff.module.js';
import { MarketMapModule } from './market-map/market-map.module.js';

@Module({
  imports: [
    AdminModule,
    MarketMapModule,
    StaffModule,
    AddressModule,
    AuthModule,
    CategoryModule,
    CartModule,
    DeliveryModule,
    FavoriteModule,
    OrderModule,
    OrderPhoneModule,
    TelegramWebhookModule,
    ProductModule,
  ],

  controllers: [HealthCtrl],
})
export class AppModule {}
