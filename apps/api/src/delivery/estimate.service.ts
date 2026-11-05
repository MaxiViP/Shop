import {
  BadGatewayException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { formatAddress } from '../common/address.js';
import type { EstimateAddress } from './estimate.schema.js';
import { YandexService } from './yandex.service.js';

export interface DeliveryEstimate {
  price: number;
  currency: 'RUB';
  calculatedAt: string;
  expiresAt: string;
  sampleWeightGrams: number;
}

@Injectable()
export class EstimateService {
  private readonly cache = new Map<string, DeliveryEstimate>();
  private readonly pending = new Map<string, Promise<DeliveryEstimate>>();

  constructor(private readonly yandex: YandexService) {}

  async estimate(address: EstimateAddress): Promise<DeliveryEstimate> {
    if (!this.yandex.isAvailable())
      throw new ServiceUnavailableException(
        'Расчёт доставки временно недоступен. Попробуйте позже.',
      );
    const fullname = formatAddress(address, false);
    const key = JSON.stringify([
      fullname.toLocaleLowerCase('ru-RU'),
      address.lat,
      address.lng,
    ]);
    const now = Date.now();
    for (const [entry, value] of this.cache)
      if (Date.parse(value.expiresAt) <= now) this.cache.delete(entry);
    const cached = this.cache.get(key);
    if (cached) return cached;
    const pending = this.pending.get(key);
    if (pending) return pending;
    if (this.pending.size >= 16)
      throw new ServiceUnavailableException(
        'Расчёт занят. Повторите через минуту.',
      );
    const task = this.calculate(address, fullname, key);
    this.pending.set(key, task);
    try {
      return await task;
    } finally {
      this.pending.delete(key);
    }
  }

  private async calculate(
    address: EstimateAddress,
    fullname: string,
    key: string,
  ): Promise<DeliveryEstimate> {
    try {
      const quote = await this.yandex.estimate({
        fullname,
        lat: address.lat,
        lng: address.lng,
      });
      if (quote.currency !== 'RUB') throw new BadGatewayException();
      const now = Date.now();
      const providerExpiry = quote.expiresAt
        ? Date.parse(quote.expiresAt)
        : NaN;
      const expiry = Number.isFinite(providerExpiry)
        ? Math.min(now + 120_000, providerExpiry)
        : now + 120_000;
      if (expiry <= now) throw new BadGatewayException();
      const result: DeliveryEstimate = {
        price: quote.price,
        currency: 'RUB',
        calculatedAt: new Date(now).toISOString(),
        expiresAt: new Date(expiry).toISOString(),
        sampleWeightGrams: 5_000,
      };
      // Bound anonymous address storage; estimates are never written to orders.
      if (this.cache.size >= 256)
        this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, result);
      return result;
    } catch {
      // Provider diagnostics and account configuration are for staff only.
      throw new BadGatewayException(
        'Не удалось рассчитать доставку по этому адресу. Проверьте адрес или попробуйте позже.',
      );
    }
  }
}
