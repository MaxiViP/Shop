import {
  BadGatewayException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { EstimateService } from './estimate.service.js';
import { EstimateCtrl } from './estimate.ctrl.js';
import { estimateAddressSchema } from './estimate.schema.js';
import { YandexService, type YandexQuote } from './yandex.service.js';

const address = { city: 'Москва', street: 'Барклая', house: '10' };
const quote: YandexQuote = {
  price: 43_701,
  currency: 'RUB',
  pickupFrom: '',
  pickupTo: '',
  deliveryFrom: '',
  deliveryTo: '',
  offerPayload: 'private-provider-payload',
  expiresAt: null,
};
function setup() {
  const yandex = new YandexService();
  vi.spyOn(yandex, 'isAvailable').mockReturnValue(true);
  const estimate = vi.spyOn(yandex, 'estimate').mockResolvedValue(quote);
  return { yandex, estimate, service: new EstimateService(yandex) };
}

describe('public delivery estimates', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('uses provider kopecks, strips private offer data and coalesces requests', async () => {
    const { service, estimate } = setup();
    const [a, b] = await Promise.all([
      service.estimate(address),
      service.estimate(address),
    ]);
    expect(a).toEqual(b);
    expect(a.price).toBe(43_701);
    expect(a).not.toHaveProperty('offerPayload');
    expect(a.sampleWeightGrams).toBe(5_000);
    expect(estimate).toHaveBeenCalledTimes(1);
    expect(estimate).toHaveBeenCalledWith({
      fullname: 'Москва, Барклая, д. 10',
      lat: undefined,
      lng: undefined,
    });
    expect(await service.estimate({ ...address, city: 'МОСКВА' })).toEqual(a);
    expect(estimate).toHaveBeenCalledTimes(1);
    await service.estimate({ ...address, house: '11' });
    expect(estimate).toHaveBeenCalledTimes(2);
  });

  it('refreshes at the earlier of the provider expiry and two minutes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-05T10:00:00Z'));
    const { service, estimate } = setup();
    estimate.mockResolvedValueOnce({
      ...quote,
      expiresAt: '2026-11-05T10:00:30Z',
    });
    const first = await service.estimate(address);
    expect(first.expiresAt).toBe('2026-11-05T10:00:30.000Z');
    vi.setSystemTime(new Date('2026-11-05T10:00:30Z'));
    const second = await service.estimate(address);
    expect(second.expiresAt).toBe('2026-11-05T10:02:30.000Z');
    expect(estimate).toHaveBeenCalledTimes(2);
  });

  it('does not serve cached estimates when the integration is disabled', async () => {
    const { service, yandex } = setup();
    await service.estimate(address);
    vi.mocked(yandex.isAvailable).mockReturnValue(false);
    await expect(service.estimate(address)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('does not cache failures or disclose provider account diagnostics', async () => {
    const { service, estimate } = setup();
    estimate.mockRejectedValueOnce(new Error('secret account diagnostics'));
    await expect(service.estimate(address)).rejects.toThrow(
      'Не удалось рассчитать доставку',
    );
    await expect(service.estimate(address)).resolves.toHaveProperty(
      'price',
      43_701,
    );
    expect(estimate).toHaveBeenCalledTimes(2);
  });

  it.each([
    { ...quote, currency: 'USD' },
    { ...quote, expiresAt: '2020-01-01T00:00:00Z' },
  ])('rejects an unusable quote', async (value) => {
    const { service, estimate } = setup();
    estimate.mockResolvedValue(value);
    await expect(service.estimate(address)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('rejects trusted price inputs and partial or invalid coordinates', () => {
    for (const value of [
      { ...address, price: 1 },
      { ...address, lat: 55 },
      { ...address, lat: 91, lng: 37 },
      { ...address, lat: 55, lng: Infinity },
      { ...address, house: ' ' },
    ])
      expect(estimateAddressSchema.safeParse(value).success).toBe(false);
    expect(
      estimateAddressSchema.parse({
        ...address,
        city: ' Москва ',
        lat: 55,
        lng: 37,
      }),
    ).toEqual({ ...address, lat: 55, lng: 37 });
  });

  it('limits anonymous requests using the resolved IP', async () => {
    const { service, estimate } = setup();
    const ctrl = new EstimateCtrl(service);
    for (let i = 0; i < 20; i++)
      await ctrl.estimate(
        { ip: '127.0.0.1' } as Parameters<typeof ctrl.estimate>[0],
        address,
      );
    expect(() =>
      ctrl.estimate(
        { ip: '127.0.0.1' } as Parameters<typeof ctrl.estimate>[0],
        address,
      ),
    ).toThrow('Слишком много попыток');
    await ctrl.estimate(
      { ip: '127.0.0.2' } as Parameters<typeof ctrl.estimate>[0],
      address,
    );
    expect(estimate).toHaveBeenCalledTimes(1);
  });
});
