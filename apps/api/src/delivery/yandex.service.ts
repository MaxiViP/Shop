import {
  BadGatewayException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';

const BASE_URL = 'https://b2b.taxi.yandex.net/b2b/cargo/integration/v2';

const intervalSchema = z.object({
  from: z.string(),
  to: z.string(),
});

const offerSchema = z.object({
  price: z.object({
    total_price: z.string(),
    total_price_with_vat: z.string(),
    currency: z.string(),
  }),
  taxi_class: z.string(),
  pickup_interval: intervalSchema,
  delivery_interval: intervalSchema,
  payload: z.string(),
  offer_ttl: z.string().optional(),
});

const offersSchema = z.object({
  offers: z.array(offerSchema),
});

const claimSchema = z.object({
  id: z.string(),
  status: z.string(),
  version: z.number().int(),
  updated_ts: z.string().optional(),
  eta: z.number().int().optional(),
  pricing: z
    .object({
      currency: z.string().optional(),
      final_price: z.string().nullable().optional(),
      offer: z
        .object({
          price: z.string().nullable().optional(),
          price_with_vat: z.string().nullable().optional(),
          valid_until: z.string().nullable().optional(),
        })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
  performer_info: z
    .object({
      courier_name: z.string(),
    })
    .nullable()
    .optional(),
  error_messages: z
    .array(z.object({ code: z.string(), message: z.string() }))
    .optional(),
});

const bulkClaimsSchema = z.object({
  claims: z.array(claimSchema),
});

const createdClaimSchema = z.object({
  id: z.string(),
});

const acceptedClaimSchema = z.object({
  id: z.string(),
  status: z.string(),
  version: z.number().int(),
});

const trackingSchema = z.object({
  route_points: z.array(
    z.object({
      type: z.enum(['source', 'destination', 'return']),
      sharing_link: z.string().nullable().optional(),
    }),
  ),
});

export interface YandexOrderItem {
  id: number;
  title: string;
  unit: 'GRAM' | 'PIECE' | 'BUNCH' | 'PACK';
  actualQty: number;
  actualTotal: number;
}

export interface YandexOrderInput {
  requestId: string;
  orderId: number;
  customerName: string;
  customerPhone: string;
  address: {
    fullname: string;
    city?: string;
    street?: string;
    building?: string;
    porch?: string;
    floor?: string;
    flat?: string;
    doorCode?: string;
    comment?: string;
  };
  items: YandexOrderItem[];
}

export interface YandexQuote {
  price: number;
  currency: string;
  pickupFrom: string;
  pickupTo: string;
  deliveryFrom: string;
  deliveryTo: string;
  expiresAt: string | null;
  offerPayload: string;
}

export interface YandexClaimInfo {
  claimId: string;
  providerStatus: string;
  providerUpdatedAt: string | null;
  price: number | null;
  currency: string;
  etaMinutes: number | null;
  trackingUrl: string | null;
  courierName: string | null;
}

export interface YandexBooking {
  quote: Omit<YandexQuote, 'offerPayload'>;
  claim: YandexClaimInfo;
}

export function rublesToKopecks(value: string) {
  const match = /^(\d{1,14})(?:\.(\d{0,4}))?$/.exec(value);

  if (!match) {
    throw new BadGatewayException(
      'Яндекс вернул некорректную стоимость доставки',
    );
  }

  const fraction = (match[2] ?? '').padEnd(4, '0');
  const tenThousandths = BigInt(match[1]) * 10_000n + BigInt(fraction || '0');
  const kopecks = (tenThousandths + 50n) / 100n;

  if (kopecks > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new BadGatewayException(
      'Яндекс вернул слишком большую стоимость доставки',
    );
  }

  return Number(kopecks);
}

@Injectable()
export class YandexService {
  isSyncAvailable() {
    return (
      process.env.YANDEX_DELIVERY_ENABLED !== 'false' &&
      Boolean(process.env.YANDEX_DELIVERY_TOKEN?.trim())
    );
  }

  isAvailable() {
    return (
      this.isSyncAvailable() &&
      Boolean(process.env.YANDEX_DELIVERY_SOURCE_ADDRESS) &&
      Boolean(process.env.YANDEX_DELIVERY_SOURCE_NAME) &&
      Boolean(process.env.YANDEX_DELIVERY_SOURCE_PHONE) &&
      Boolean(process.env.YANDEX_DELIVERY_SOURCE_EMAIL)
    );
  }

  async calculate(input: YandexOrderInput): Promise<YandexQuote> {
    this.config();

    const response = offersSchema.parse(
      await this.request('/offers/calculate', {
        method: 'POST',
        body: this.offerBody(input),
      }),
    );
    const offer = response.offers.find((item) => item.taxi_class === 'express');

    if (!offer) {
      throw new BadGatewayException(
        'Яндекс не предложил доступную экспресс-доставку',
      );
    }

    return {
      price: rublesToKopecks(offer.price.total_price_with_vat),
      currency: offer.price.currency,
      pickupFrom: offer.pickup_interval.from,
      pickupTo: offer.pickup_interval.to,
      deliveryFrom: offer.delivery_interval.from,
      deliveryTo: offer.delivery_interval.to,
      expiresAt: offer.offer_ttl ?? null,
      offerPayload: offer.payload,
    };
  }

  async book(input: YandexOrderInput): Promise<YandexBooking> {
    const quote = await this.calculate(input);
    const created = createdClaimSchema.parse(
      await this.request('/claims/create', {
        method: 'POST',
        query: { request_id: input.requestId },
        body: this.claimBody(input, quote.offerPayload),
      }),
    );
    const assessed = await this.waitForAssessment(created.id);

    if (assessed.status !== 'ready_for_approval') {
      throw new BadGatewayException(this.claimError(assessed));
    }

    const assessedPrice = this.normalizeClaim(assessed, null).price;

    if (assessedPrice === null) {
      throw new BadGatewayException(
        'Яндекс не вернул актуальную стоимость заявки',
      );
    }

    acceptedClaimSchema.parse(
      await this.request('/claims/accept', {
        method: 'POST',
        query: { claim_id: created.id },
        body: { version: assessed.version },
      }),
    );

    const claim = await this.sync(created.id);

    return {
      quote: {
        price: quote.price,
        currency: quote.currency,
        pickupFrom: quote.pickupFrom,
        pickupTo: quote.pickupTo,
        deliveryFrom: quote.deliveryFrom,
        deliveryTo: quote.deliveryTo,
        expiresAt: quote.expiresAt,
      },
      claim: {
        ...claim,
        price: claim.price ?? assessedPrice,
      },
    };
  }

  async sync(claimId: string): Promise<YandexClaimInfo> {
    const claim = claimSchema.parse(
      await this.request('/claims/info', {
        method: 'POST',
        query: { claim_id: claimId },
      }),
    );

    let trackingUrl: string | null = null;

    try {
      const tracking = trackingSchema.parse(
        await this.request('/claims/tracking-links', {
          method: 'GET',
          query: { claim_id: claimId },
        }),
      );
      trackingUrl =
        tracking.route_points.find((point) => point.type === 'destination')
          ?.sharing_link ?? null;
    } catch (error) {
      if (!(error instanceof BadGatewayException)) throw error;
    }

    return this.normalizeClaim(claim, trackingUrl);
  }

  async bulkInfo(claimIds: string[]): Promise<YandexClaimInfo[]> {
    if (!claimIds.length || claimIds.length > 1_000) {
      throw new RangeError('claims/bulk_info accepts from 1 to 1000 claim IDs');
    }

    const response = bulkClaimsSchema.parse(
      await this.request('/claims/bulk_info', {
        method: 'POST',
        body: { claim_ids: claimIds },
      }),
    );

    return response.claims.map((claim) => this.normalizeClaim(claim, null));
  }

  private async waitForAssessment(claimId: string) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const claim = claimSchema.parse(
        await this.request('/claims/info', {
          method: 'POST',
          query: { claim_id: claimId },
        }),
      );

      if (!['new', 'estimating'].includes(claim.status)) return claim;
      await delay(1_000);
    }

    throw new BadGatewayException(
      'Яндекс не успел рассчитать окончательную стоимость заявки',
    );
  }

  private normalizeClaim(
    claim: z.infer<typeof claimSchema>,
    trackingUrl: string | null,
  ): YandexClaimInfo {
    const money =
      claim.pricing?.final_price ??
      claim.pricing?.offer?.price_with_vat ??
      claim.pricing?.offer?.price ??
      null;

    return {
      claimId: claim.id,
      providerStatus: claim.status,
      providerUpdatedAt: claim.updated_ts ?? null,
      price: money === null ? null : rublesToKopecks(money),
      currency: claim.pricing?.currency ?? 'RUB',
      etaMinutes: claim.eta ?? null,
      trackingUrl,
      courierName: claim.performer_info?.courier_name ?? null,
    };
  }

  private offerBody(input: YandexOrderInput) {
    const config = this.config();

    return {
      items: input.items.map((item) => ({
        quantity: 1,
        pickup_point: 1,
        dropoff_point: 2,
        ...(item.unit === 'GRAM' ? { weight: item.actualQty / 1_000 } : {}),
      })),
      route_points: [
        { id: 1, fullname: config.sourceAddress },
        { id: 2, fullname: input.address.fullname },
      ],
      requirements: {
        taxi_classes: ['express'],
      },
    };
  }

  private claimBody(input: YandexOrderInput, offerPayload: string) {
    const config = this.config();
    const callbackUrl = this.callbackUrl();

    return {
      items: input.items.map((item) => ({
        extra_id: String(item.id),
        pickup_point: 1,
        dropoff_point: 2,
        title: item.title,
        ...(item.unit === 'GRAM' ? { weight: item.actualQty / 1_000 } : {}),
        cost_value: (item.actualTotal / 100).toFixed(2),
        cost_currency: 'RUB',
        quantity: 1,
      })),
      route_points: [
        {
          point_id: 1,
          visit_order: 1,
          type: 'source',
          contact: {
            name: config.sourceName,
            phone: config.sourcePhone,
            email: config.sourceEmail,
          },
          address: {
            fullname: config.sourceAddress,
            ...(config.sourceCoordinates
              ? { coordinates: config.sourceCoordinates }
              : {}),
            comment: `Заказ №${input.orderId} готов. Заказ оплачен, не требуйте оплату с получателя.`,
          },
          skip_confirmation: true,
        },
        {
          point_id: 2,
          visit_order: 2,
          type: 'destination',
          contact: {
            name: input.customerName,
            phone: input.customerPhone,
          },
          address: {
            fullname: input.address.fullname,
            city: input.address.city,
            street: input.address.street,
            building: input.address.building,
            porch: input.address.porch,
            sfloor: input.address.floor,
            sflat: input.address.flat,
            door_code: input.address.doorCode,
            comment: input.address.comment,
          },
          external_order_id: String(input.orderId),
          skip_confirmation: true,
        },
      ],
      client_requirements: {
        taxi_class: 'express',
      },
      offer_payload: offerPayload,
      optional_return: false,
      skip_client_notify: false,
      ...(callbackUrl
        ? { callback_properties: { callback_url: callbackUrl } }
        : {}),
    };
  }

  private callbackUrl() {
    const value = process.env.YANDEX_DELIVERY_CALLBACK_URL?.trim();
    if (!value) return null;
    if (value.endsWith('?') || value.endsWith('&')) return value;
    return value.includes('?') ? `${value}&` : `${value}?`;
  }

  private config() {
    if (!this.isAvailable()) {
      throw new ServiceUnavailableException(
        'Яндекс Доставка не настроена: проверьте token и данные точки отправления',
      );
    }

    const longitude = this.coordinate(
      process.env.YANDEX_DELIVERY_SOURCE_LONGITUDE,
    );
    const latitude = this.coordinate(
      process.env.YANDEX_DELIVERY_SOURCE_LATITUDE,
    );

    if ((longitude === null) !== (latitude === null)) {
      throw new ServiceUnavailableException(
        'Координаты точки отправления должны содержать долготу и широту',
      );
    }

    return {
      token: process.env.YANDEX_DELIVERY_TOKEN!,
      sourceAddress: process.env.YANDEX_DELIVERY_SOURCE_ADDRESS!,
      sourceName: process.env.YANDEX_DELIVERY_SOURCE_NAME!,
      sourcePhone: process.env.YANDEX_DELIVERY_SOURCE_PHONE!,
      sourceEmail: process.env.YANDEX_DELIVERY_SOURCE_EMAIL!,
      sourceCoordinates:
        longitude === null || latitude === null
          ? null
          : ([longitude, latitude] as [number, number]),
    };
  }

  private coordinate(value: string | undefined) {
    if (!value) return null;
    const coordinate = Number(value);
    if (!Number.isFinite(coordinate)) {
      throw new ServiceUnavailableException(
        'Некорректные координаты точки отправления',
      );
    }
    return coordinate;
  }

  private async request(
    path: string,
    options: {
      method: 'GET' | 'POST';
      query?: Record<string, string>;
      body?: object;
    },
  ): Promise<unknown> {
    const token = this.token();
    const url = new URL(`${BASE_URL}${path}`);

    for (const [key, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(key, value);
    }

    let response: Response;

    try {
      response = await fetch(url, {
        method: options.method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Accept-Language': 'ru',
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new BadGatewayException('Яндекс Доставка временно недоступна');
    }

    const payload: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      const error = z
        .object({ message: z.string().optional() })
        .safeParse(payload);
      throw new BadGatewayException(
        error.success && error.data.message
          ? `Ошибка Яндекс Доставки: ${error.data.message}`
          : `Ошибка Яндекс Доставки (${response.status})`,
      );
    }

    return payload;
  }

  private token() {
    const token = process.env.YANDEX_DELIVERY_TOKEN?.trim();

    if (!this.isSyncAvailable() || !token) {
      throw new ServiceUnavailableException(
        'Яндекс Доставка не настроена: проверьте token',
      );
    }

    return token;
  }

  private claimError(claim: z.infer<typeof claimSchema>) {
    return (
      claim.error_messages?.map((error) => error.message).join('; ') ||
      `Яндекс не может выполнить доставку (статус: ${claim.status})`
    );
  }
}
