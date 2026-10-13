import type { AuthRequest } from '../auth/auth.guard.js';
import { Body, Controller, Get, Param, Patch, Req, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard.js';
import { ResearchDraftsService } from './research-drafts.service.js';
import { researchReviewPatch, type ResearchReviewPatch } from './research-drafts.schema.js';

@Controller('admin/research-drafts')
@UseGuards(AdminGuard)
export class ResearchDraftsCtrl {
  constructor(private readonly drafts: ResearchDraftsService) {}

  @Get()
  list() {
    return this.drafts.list();
  }

  @Patch('stores/:key')
  storeReview(
    @Req() request: AuthRequest,
    @Param('key') key: string,
    @Body({ schema: researchReviewPatch }) patch: ResearchReviewPatch,
  ) {
    return this.drafts.storeReview(key, patch, request.user.id);
  }

  @Patch('products/:key')
  productReview(
    @Req() request: AuthRequest,
    @Param('key') key: string,
    @Body({ schema: researchReviewPatch }) patch: ResearchReviewPatch,
  ) {
    return this.drafts.productReview(key, patch, request.user.id);
  }
}
