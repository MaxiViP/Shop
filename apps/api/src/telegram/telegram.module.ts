import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module.js';
import { TelegramService } from './telegram.service.js';

@Module({
  imports: [DbModule],
  providers: [TelegramService],
  exports: [TelegramService],
})
export class TelegramModule {}
