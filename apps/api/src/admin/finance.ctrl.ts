import { Body, Controller, Get, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AdminGuard } from '../auth/admin.guard.js';
import type { AuthRequest } from '../auth/auth.guard.js';
import { FinanceService } from './finance.service.js';
import { PayoutsService } from './payouts.service.js';
import { financeQuerySchema, payoutSchema, type FinanceQuery, type PayoutInput } from './finance.schema.js';
import { dateSchema } from './schedule.schema.js';

@Controller('admin/finance')
@UseGuards(AdminGuard)
export class FinanceCtrl {
  constructor(private readonly finance: FinanceService) {}
  @Get() report(@Query({ schema: financeQuerySchema }) query: FinanceQuery) {
    return this.finance.report(query);
  }
  @Get('days/:date') day(@Param('date', { schema: dateSchema }) date: string) {
    return this.finance.day(date);
  }
  @Get('export.csv') async csv(
    @Query({ schema: financeQuerySchema }) query: FinanceQuery,
    @Res({ passthrough: true }) response: Response,
  ) {
    const csv = await this.finance.csv(query);
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader('Content-Disposition', `attachment; filename="${csv.filename}"`);
    return csv.body;
  }
}
@Controller('admin/payouts')
@UseGuards(AdminGuard)
export class PayoutsCtrl {
  constructor(private readonly payouts: PayoutsService) {}
  @Get() list() { return this.payouts.list(); }
  @Post() create(@Body({ schema: payoutSchema }) input: PayoutInput,
    @Req() request: AuthRequest) {
    return this.payouts.create(input, request.user.id);
  }
}
