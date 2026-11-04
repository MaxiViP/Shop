import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard.js';
import type { AuthRequest } from '../auth/auth.guard.js';
import { ServiceFeeService } from './service-fee.service.js';
import {
  bulkApplySchema,
  bulkPreviewSchema,
  type BulkApplyInput,
  type BulkPreviewInput,
} from './service-fee.schema.js';

// Three suffix segments: cannot match existing /admin/products/:id or /pricing routes.
@Controller('admin/products/service-fee/bulk')
@UseGuards(AdminGuard)
export class ServiceFeeCtrl {
  constructor(private readonly service: ServiceFeeService) {}
  @Post('preview')
  preview(
    @Body({ schema: bulkPreviewSchema }) input: BulkPreviewInput,
    @Req() request: AuthRequest,
  ) {
    return this.service.preview(input, request.user.id);
  }
  @Post('apply')
  apply(
    @Body({ schema: bulkApplySchema }) input: BulkApplyInput,
    @Req() request: AuthRequest,
  ) {
    return this.service.apply(input, request.user.id);
  }
}
