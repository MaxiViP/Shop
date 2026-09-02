import { Controller, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { DeliveryService } from './delivery.service.js';

@Controller('delivery/yandex')
export class YandexCallbackCtrl {
  constructor(private readonly delivery: DeliveryService) {}

  @Post('callback')
  async callback(
    @Query('claim_id', {
      schema: z.string().min(32).max(64),
    })
    claimId: string,
  ) {
    await this.delivery.syncClaim(claimId);
    return { ok: true };
  }
}
