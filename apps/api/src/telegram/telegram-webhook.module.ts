import { Module } from '@nestjs/common';
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
  imports: [AuthModule, DbModule, StaffModule, TelegramModule],
  controllers: [TelegramController, CustomerTelegramController, StaffLinkController],
  providers: [TelegramUpdateService, TelegramWebhookGuard, CustomerWebhookGuard, CustomerUpdateService,
    StaffLinkService, StaffBotFlowService, StaffBotService],
})
export class TelegramWebhookModule {}
