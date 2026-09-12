import { Body, Controller, Get, Patch, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard } from '../auth/admin.guard.js';
import type { AuthRequest } from '../auth/auth.guard.js';
import { SettingsService } from './settings.service.js';
import { settingsSchema } from './settings.schema.js';
export { settingsSchema } from './settings.schema.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { StaffGuard } from '../auth/staff.guard.js';
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
    return this.settings.update(body, request.user.id);
  }
}

@Controller('shop/settings')
export class PublicSettingsCtrl {
  constructor(private readonly settings: SettingsService) {}
  @Get()
  async get() {
    const { minDeliverySubtotal, deliveryEnabled, pickupEnabled } =
      await this.settings.get();
    return { minDeliverySubtotal, deliveryEnabled, pickupEnabled };
  }
}

@Controller('staff/extra-limits')
@UseGuards(AuthGuard, StaffGuard)
export class ExtraLimitsCtrl {
  constructor(private readonly settings: SettingsService) {}
  @Get()
  async get() {
    const { maxOrderExtraUnitPrice, maxOrderExtrasTotal } =
      await this.settings.get();
    return { maxOrderExtraUnitPrice, maxOrderExtrasTotal };
  }
}
