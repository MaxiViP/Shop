import { Module } from '@nestjs/common';
import { CartModule } from '../cart/cart.module.js';
import { CustomerShopService } from './customer-shop.service.js';
import { CustomerCheckoutService } from './customer-checkout.service.js';
import { OrderModule } from '../order/order.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { StaffLinkController } from './staff-link.controller.js';
import { StaffLinkService } from './staff-link.service.js';
import { StaffBotFlowService } from './staff-bot-flow.service.js';
import { StaffBotService } from './staff-bot.service.js';
import { DbModule } from '../db/db.module.js';
import { StaffModule } from '../staff/staff.module.js';
import { TelegramModule } from './telegram.module.js';
import { TelegramController } from './telegram.controller.js';
import { TelegramUpdateService } from './telegram-update.service.js';
import { TelegramWebhookGuard } from './telegram-webhook.guard.js';
import { CustomerTelegramController } from './customer.controller.js';
import { CustomerWebhookGuard } from './customer-webhook.guard.js';
import { CustomerUpdateService } from './customer-update.service.js';

@Module({
  imports: [AuthModule, DbModule, StaffModule, TelegramModule, OrderModule, CartModule],
  controllers: [TelegramController, CustomerTelegramController, StaffLinkController],
  providers: [CustomerShopService, CustomerCheckoutService, TelegramUpdateService, TelegramWebhookGuard, CustomerWebhookGuard, CustomerUpdateService,
    StaffLinkService, StaffBotFlowService, StaffBotService],
})
export class TelegramWebhookModule {}
