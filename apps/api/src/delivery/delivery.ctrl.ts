import { Controller, Get, Param } from '@nestjs/common';
import { z } from 'zod';
import { DeliveryService } from './delivery.service.js';

const tokenSchema = z
  .string()
  .min(40)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/);

@Controller('track')
export class DeliveryCtrl {
  constructor(private readonly delivery: DeliveryService) {}

  @Get(':token')
  get(
    @Param('token', {
      schema: tokenSchema,
    })
    token: string,
  ) {
    return this.delivery.get(token);
  }
}
