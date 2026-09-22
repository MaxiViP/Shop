import { Body, Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { CustomerWebhookGuard } from './customer-webhook.guard.js';
import { CustomerUpdateService } from './customer-update.service.js';

@Controller('telegram/customer')
@UseGuards(CustomerWebhookGuard)
export class CustomerTelegramController {
  constructor(@Inject(CustomerUpdateService) private readonly updates: CustomerUpdateService) {}

  @Post('webhook')
  @HttpCode(200)
  async webhook(@Body() body: unknown) {
    await this.updates.handle(body);
    return { ok: true };
  }
}
