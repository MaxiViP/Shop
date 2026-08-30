import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthCtrl {
  @Get()
  check() {
    return { ok: true };
  }
}
