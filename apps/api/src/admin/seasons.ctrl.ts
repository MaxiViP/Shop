import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard.js';
import { idSchema } from './schema.js';
import { seasonAssignment, seasonPatch, seasonSchema, type SeasonAssignment, type SeasonInput } from './seasons.schema.js';
import { SeasonsService } from './seasons.service.js';

@Controller('admin/seasons')
@UseGuards(AdminGuard)
export class SeasonsCtrl {
  constructor(private readonly seasons: SeasonsService) {}
  @Get()
  list() { return this.seasons.list(); }
  @Get('presets')
  catalog() { return this.seasons.catalog(); }
  @Post('presets')
  presets() { return this.seasons.presets(); }
  @Post()
  create(@Body({ schema: seasonSchema }) data: SeasonInput) { return this.seasons.create(data); }
  @Patch(':id')
  update(@Param('id', { schema: idSchema }) id: number, @Body({ schema: seasonPatch }) data: Partial<SeasonInput>) {
    return this.seasons.update(id, data);
  }
  @Post('assign')
  assign(@Body({ schema: seasonAssignment }) data: SeasonAssignment) { return this.seasons.assign(data); }
}
