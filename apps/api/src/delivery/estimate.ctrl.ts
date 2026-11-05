import { Body, Controller, Header, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AttemptLimit } from '../auth/attempt-limit.js';
import { clientIp } from '../auth/proxy.js';
import {
  estimateAddressSchema,
  type EstimateAddress,
} from './estimate.schema.js';
import { EstimateService } from './estimate.service.js';

@Controller('delivery')
export class EstimateCtrl {
  private readonly limit = new AttemptLimit(20, 300, 1);

  constructor(private readonly estimates: EstimateService) {}

  @Post('estimate')
  @Header('Cache-Control', 'no-store')
  estimate(
    @Req() request: Request,
    @Body({ schema: estimateAddressSchema }) address: EstimateAddress,
  ) {
    this.limit.check(clientIp(request));
    return this.estimates.estimate(address);
  }
}
