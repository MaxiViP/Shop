import {
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard } from '../auth/admin.guard.js';
import type { AuthRequest } from '../auth/auth.guard.js';
import { AdminActivityService } from './activity.service.js';
import { idSchema } from './schema.js';
@Controller('admin/activity')
@UseGuards(AdminGuard)
export class AdminActivityCtrl {
  constructor(private readonly activity: AdminActivityService) {}
  @Get()
  list(
    @Req() request: AuthRequest,
    @Query({
      schema: z.object({
        page: z.coerce.number().int().min(1).max(100000).default(1),
      }),
    })
    query: { page: number },
  ) {
    return this.activity.list(request.user.id, query.page);
  }
  @Post(':id/retry')
  retry(
    @Req() request: AuthRequest,
    @Param('id', { schema: idSchema }) id: number,
  ) {
    return this.activity.retry(request.user.id, id);
  }
  @Post('test')
  test(@Req() request: AuthRequest) {
    return this.activity.test(request.user.id);
  }
}
