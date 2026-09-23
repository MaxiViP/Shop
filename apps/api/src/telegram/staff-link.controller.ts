import { Controller, Header, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard, type AuthRequest } from '../auth/auth.guard.js';
import { StaffGuard } from '../auth/staff.guard.js';
import { StaffLinkService } from './staff-link.service.js';

@Controller('staff/telegram')
@UseGuards(AuthGuard, StaffGuard)
export class StaffLinkController {
  constructor(private readonly links: StaffLinkService) {}

  @Post('link-code')
  @Header('Cache-Control', 'no-store')
  createCode(@Req() request: AuthRequest) {
    return this.links.createCode(request.user.id);
  }
}
