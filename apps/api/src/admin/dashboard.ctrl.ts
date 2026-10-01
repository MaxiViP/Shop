import { Controller, Get, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard.js';
import { DashboardService } from './dashboard.service.js';
@Controller('admin/dashboard')
@UseGuards(AdminGuard)
export class DashboardCtrl {
  constructor(private readonly dashboard: DashboardService) {}
  @Get() get() { return this.dashboard.get(); }
}
