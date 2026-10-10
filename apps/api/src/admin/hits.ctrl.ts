import { Body, Controller, Get, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard.js';
import { hitAssignment, hitQuery, hitSettingsSchema, type HitAssignment, type HitQuery, type HitSettingsInput } from './hits.schema.js';
import { HitsService } from './hits.service.js';

@Controller('admin/hits')
@UseGuards(AdminGuard)
export class HitsCtrl {
  constructor(private readonly hits: HitsService) {}
  @Get()
  list(@Query({ schema: hitQuery }) query: HitQuery) { return this.hits.list(query); }
  @Post('assign')
  assign(@Body({ schema: hitAssignment }) data: HitAssignment) { return this.hits.assign(data); }
  @Patch('settings')
  settings(@Body({ schema: hitSettingsSchema }) data: HitSettingsInput) { return this.hits.recalculate(true, data); }
  @Post('recalculate')
  recalculate() { return this.hits.recalculate(); }
}
