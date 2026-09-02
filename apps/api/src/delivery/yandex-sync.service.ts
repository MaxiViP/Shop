import {
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { DeliveryService } from './delivery.service.js';

const DEFAULT_SYNC_INTERVAL_MS = 30_000;

export function yandexSyncInterval() {
  const interval = Number(process.env.YANDEX_DELIVERY_SYNC_INTERVAL_MS);

  return Number.isSafeInteger(interval) && interval >= 1_000
    ? interval
    : DEFAULT_SYNC_INTERVAL_MS;
}

@Injectable()
export class YandexSyncService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly delivery: DeliveryService) {}

  onApplicationBootstrap() {
    this.timer = setInterval(() => {
      void this.delivery.syncActiveYandexDeliveries();
    }, yandexSyncInterval());
    this.timer.unref();
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }
}
