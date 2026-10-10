import { Controller, ForbiddenException, Get, Header, Req, UseGuards } from '@nestjs/common';
import { AuthGuard, type AuthRequest } from '../auth/auth.guard.js';
import { PromoService } from './promo.service.js';
@Controller('promo-codes')
@UseGuards(AuthGuard)
export class PromoCtrl {
  constructor(private readonly promos: PromoService) {}
  @Get()
  @Header('Cache-Control', 'private, no-store')
  mine(@Req() request: AuthRequest) {
    if (request.user.role !== 'USER') throw new ForbiddenException();
    return this.promos.mine(request.user.id);
  }
}
