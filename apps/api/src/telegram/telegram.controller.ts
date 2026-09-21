import { Body, Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { TelegramWebhookGuard } from './telegram-webhook.guard.js';
import { TelegramUpdateService } from './telegram-update.service.js';

@Controller('telegram')
@UseGuards(TelegramWebhookGuard)
export class TelegramController {
  constructor(@Inject(TelegramUpdateService) private readonly updates: TelegramUpdateService) {}

  @Post('webhook')
  @HttpCode(200)
  async webhook(@Body() body: unknown) {
    await this.updates.handle(body);
    return { ok: true };
  }
}
