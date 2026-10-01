import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type { AuthRequest } from '../auth/auth.guard.js';
import { AdminGuard } from '../auth/admin.guard.js';
import { ScheduleService } from './schedule.service.js';
import { exceptionIdSchema, exceptionSchema, weekdaySchema, weeklySchema,
  type ExceptionInput, type WeeklyInput } from './schedule.schema.js';

@Controller('shop/status')
export class ShopStatusCtrl {
  constructor(private readonly schedule: ScheduleService) {}
  @Get() status() { return this.schedule.status(); }
}

@Controller('admin/schedule')
@UseGuards(AdminGuard)
export class ScheduleCtrl {
  constructor(private readonly schedule: ScheduleService) {}
  @Get() get() { return this.schedule.get(); }
  @Patch('weekly/:weekday') updateWeekly(
    @Param('weekday', { schema: weekdaySchema }) weekday: number,
    @Body({ schema: weeklySchema }) input: WeeklyInput,
    @Req() request: AuthRequest,
  ) { return this.schedule.updateWeekly(weekday, input, request.user.id); }
  @Post('exceptions') createException(
    @Body({ schema: exceptionSchema }) input: ExceptionInput,
    @Req() request: AuthRequest,
  ) { return this.schedule.createException(input, request.user.id); }
  @Patch('exceptions/:id') updateException(
    @Param('id', { schema: exceptionIdSchema }) id: number,
    @Body({ schema: exceptionSchema }) input: ExceptionInput,
    @Req() request: AuthRequest,
  ) { return this.schedule.updateException(id, input, request.user.id); }
  @Delete('exceptions/:id') deleteException(
    @Param('id', { schema: exceptionIdSchema }) id: number,
    @Req() request: AuthRequest,
  ) { return this.schedule.deleteException(id, request.user.id); }
}
