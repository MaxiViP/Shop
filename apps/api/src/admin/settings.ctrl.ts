import { Body, Controller, Get, Patch, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard } from '../auth/admin.guard.js';
import type { AuthRequest } from '../auth/auth.guard.js';
import { SettingsService } from './settings.service.js';
export const settingsSchema = z.strictObject({
  weightToleranceBps: z.number().int().min(0).max(5000),
  customerResponseMinutes: z.number().int().min(1).max(120).optional(),
});
@Controller('admin/settings')
@UseGuards(AdminGuard)
export class SettingsCtrl {
  constructor(private readonly settings: SettingsService) {}
  @Get()
  get() {
    return this.settings.get();
  }
  @Patch()
  update(
    @Body({ schema: settingsSchema }) body: z.infer<typeof settingsSchema>,
    @Req() request: AuthRequest,
  ) {
    return this.settings.update(body.weightToleranceBps, request.user.id, body.customerResponseMinutes);
  }
}
