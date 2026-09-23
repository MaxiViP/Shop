import { Injectable } from '@nestjs/common';
import { StaffBotService } from './staff-bot.service.js';

// Keep the existing STAFF webhook route while routing all updates through v3 authorization.
@Injectable()
export class TelegramUpdateService {
  constructor(private readonly sellerBot: StaffBotService) {}

  handle(body: unknown): Promise<void> {
    return this.sellerBot.handle(body);
  }
}
