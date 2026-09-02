import { ServiceUnavailableException } from '@nestjs/common';
import {
  rublesToKopecks,
  type YandexOrderInput,
  YandexService,
} from './yandex.service.js';

const input: YandexOrderInput = {
  requestId: '123e4567-e89b-12d3-a456-426614174000',
  orderId: 17,
  customerName: 'Максим',
  customerPhone: '+79050000000',
  address: {
    fullname: 'Москва, Пинский проезд, 7',
    city: 'Москва',
    street: 'Пинский проезд',
    building: '7',
  },
  items: [
    {
      id: 1,
      title: 'Яблоки',
      unit: 'GRAM',
      actualQty: 1_063,
      actualTotal: 47_835,
    },
  ],
};

function configured() {
  vi.stubEnv('YANDEX_DELIVERY_TOKEN', 'test-token');
  vi.stubEnv('YANDEX_DELIVERY_SOURCE_ADDRESS', 'Москва, рынок, 1');
  vi.stubEnv('YANDEX_DELIVERY_SOURCE_NAME', 'Магазин');
  vi.stubEnv('YANDEX_DELIVERY_SOURCE_PHONE', '+79990000000');
  vi.stubEnv('YANDEX_DELIVERY_SOURCE_EMAIL', 'shop@example.com');
  vi.stubEnv('YANDEX_DELIVERY_CALLBACK_URL', '');
}

function json(value: object) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function offer(totalPriceWithVat = '437.00') {
  return {
    offers: [
      {
        price: {
          total_price: '364.17',
          total_price_with_vat: totalPriceWithVat,
          currency: 'RUB',
        },
        taxi_class: 'express',
        pickup_interval: {
          from: '2026-09-01T10:00:00Z',
          to: '2026-09-01T10:15:00Z',
        },
        delivery_interval: {
          from: '2026-09-01T10:15:00Z',
          to: '2026-09-01T10:40:00Z',
        },
        payload: 'official-offer-payload',
        offer_ttl: '2026-09-01T10:05:00Z',
      },
    ],
  };
}

function claim(
  status: string,
  price = '441.25',
  finalPrice: string | null = null,
) {
  return {
    id: '741cedf82cd464fa6fa16d87155c636',
    status,
    version: 1,
    updated_ts: '2026-09-01T10:01:00Z',
    pricing: {
      currency: 'RUB',
      final_price: finalPrice,
      offer: {
        price: '367.71',
        price_with_vat: price,
        valid_until: '2026-09-01T10:10:00Z',
      },
    },
  };
}

describe('YandexService', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('converts decimal rubles to integer kopecks without Float money', () => {
    expect(rublesToKopecks('437.00')).toBe(43_700);
    expect(rublesToKopecks('12.3450')).toBe(1_235);
    expect(rublesToKopecks('0.1050')).toBe(11);
    expect(rublesToKopecks('999999999999.9999')).toBe(100_000_000_000_000);
  });

  it('gets claims in bulk and uses final_price only when present', async () => {
    configured();
    const firstClaim = claim('pickuped', '441.25');
    const terminalClaim = claim('delivered_finish', '441.25', '439.9950');
    const secondClaim = {
      ...terminalClaim,
      id: '841cedf82cd464fa6fa16d87155c637',
      pricing: {
        ...terminalClaim.pricing,
        offer: {
          ...terminalClaim.pricing.offer,
          price: null,
          price_with_vat: null,
        },
      },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(json({ claims: [firstClaim, secondClaim] }));
    vi.stubGlobal('fetch', fetchMock);

    const claims = await new YandexService().bulkInfo([
      firstClaim.id,
      secondClaim.id,
    ]);

    expect(claims.map(({ price }) => price)).toEqual([44_125, 44_000]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/claims/bulk_info');
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({
      claim_ids: [firstClaim.id, secondClaim.id],
    });
  });

  it('returns the Yandex offer price without local recalculation', async () => {
    configured();
    const fetchMock = vi.fn().mockResolvedValue(json(offer('807.60')));
    vi.stubGlobal('fetch', fetchMock);

    const quote = await new YandexService().calculate(input);

    expect(quote.price).toBe(80_760);
    expect(quote.currency).toBe('RUB');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/offers/calculate');

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(request.headers).toMatchObject({
      Authorization: 'Bearer test-token',
    });
    expect(JSON.parse(String(request.body))).toMatchObject({
      requirements: { taxi_classes: ['express'] },
    });
  });

  it('uses the assessed claim price when booking and never trusts the old quote', async () => {
    configured();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(offer('437.00')))
      .mockResolvedValueOnce(json({ id: '741cedf82cd464fa6fa16d87155c636' }))
      .mockResolvedValueOnce(json(claim('ready_for_approval', '441.25')))
      .mockResolvedValueOnce(
        json({
          id: '741cedf82cd464fa6fa16d87155c636',
          status: 'accepted',
          version: 1,
        }),
      )
      .mockResolvedValueOnce(json(claim('accepted', '441.25')))
      .mockResolvedValueOnce(
        json({
          route_points: [
            {
              id: 2,
              type: 'destination',
              visit_order: 2,
              sharing_link: 'https://yandex.example/track',
            },
          ],
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const booking = await new YandexService().book(input);

    expect(booking.quote.price).toBe(43_700);
    expect(booking.claim.price).toBe(44_125);
    expect(booking.claim.trackingUrl).toBe('https://yandex.example/track');
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      expect.stringContaining('/offers/calculate'),
      expect.stringContaining('/claims/create?request_id='),
      expect.stringContaining('/claims/info?claim_id='),
      expect.stringContaining('/claims/accept?claim_id='),
      expect.stringContaining('/claims/info?claim_id='),
      expect.stringContaining('/claims/tracking-links?claim_id='),
    ]);
    const createRequest = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(JSON.parse(String(createRequest.body))).not.toHaveProperty(
      'callback_properties',
    );
  });

  it('starts without credentials and fails only when Yandex is used', async () => {
    vi.stubEnv('YANDEX_DELIVERY_TOKEN', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const service = new YandexService();

    expect(service.isAvailable()).toBe(false);
    await expect(service.calculate(input)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('can sync with only a token and without a callback URL', () => {
    vi.stubEnv('YANDEX_DELIVERY_TOKEN', 'test-token');
    vi.stubEnv('YANDEX_DELIVERY_SOURCE_ADDRESS', '');
    vi.stubEnv('YANDEX_DELIVERY_SOURCE_NAME', '');
    vi.stubEnv('YANDEX_DELIVERY_SOURCE_PHONE', '');
    vi.stubEnv('YANDEX_DELIVERY_SOURCE_EMAIL', '');
    vi.stubEnv('YANDEX_DELIVERY_CALLBACK_URL', '');

    const service = new YandexService();

    expect(service.isSyncAvailable()).toBe(true);
    expect(service.isAvailable()).toBe(false);
  });
});
