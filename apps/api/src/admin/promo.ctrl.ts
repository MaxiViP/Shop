import { Body, Controller, Get, Header, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard.js';
import type { AuthRequest } from '../auth/auth.guard.js';
import { PromoService } from '../promo/promo.service.js';
import { promoIssueSchema, promoQuerySchema, type PromoIssue, type PromoQuery } from '../promo/schema.js';
import { idSchema } from './schema.js';
@Controller('admin/promo-codes')
@UseGuards(AdminGuard)
export class AdminPromoCtrl {
  constructor(private readonly promos: PromoService) {}
  @Get()
  @Header('Cache-Control', 'private, no-store')
  list(@Query({ schema: promoQuerySchema }) query: PromoQuery) { return this.promos.list(query); }
  @Post()
  issue(@Req() request: AuthRequest, @Body({ schema: promoIssueSchema }) input: PromoIssue) {
    return this.promos.issue(request.user.id, input);
  }
  @Post(':id/revoke')
  revoke(@Req() request: AuthRequest, @Param('id', { schema: idSchema }) id: number) {
    return this.promos.revoke(request.user.id, id);
  }
}
