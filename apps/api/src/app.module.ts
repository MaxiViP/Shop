import { Module } from '@nestjs/common';
import { HealthCtrl } from './health/health.ctrl.js';

@Module({
  controllers: [HealthCtrl],
})
export class AppModule {}
