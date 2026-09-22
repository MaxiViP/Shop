import { Module } from '@nestjs/common';
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
  imports: [DbModule, StaffModule, TelegramModule],
  controllers: [TelegramController, CustomerTelegramController],
  providers: [TelegramUpdateService, TelegramWebhookGuard, CustomerWebhookGuard, CustomerUpdateService],
})
export class TelegramWebhookModule {}
