import { slideSchema, safeSlideLink } from './slides.schema.js';
import { renderSlide, slideStatus } from './slides.js';
import { SlidesService } from './slides.service.js';
import type { DbService } from '../db/db.service.js';

const slide = { id: 1, type: 'PERMANENT' as const, content: 'CUSTOM' as const, title: 'Продукты с рынка', text: 'Выбирайте продукты',
  eyebrow: null, image: null, position: 'center' as const, buttonLabel: 'Каталог', to: '/catalog',
  active: true, published: true, priority: false, sortOrder: 0, startsAt: null, endsAt: null };
const now = new Date('2026-10-10T09:00:00.000Z');
describe('Home content contracts', () => {
  it.each(['/catalog', '/catalog?tag=hit', 'https://korzinamarket.ru/delivery'])('permits safe link %s', link => expect(safeSlideLink(link)).toBe(true));
  it.each(['javascript:alert(1)', 'data:text/html,<script>', '//evil.test', '/%2fexternal.test', '/\\evil.test', 'https://user:pass@example.com', 'http://example.com'])('rejects unsafe link %s', link => expect(safeSlideLink(link)).toBe(false));
  it('requires a paired CTA, a valid interval and an end for temporary publication', () => {
    const { id: _id, ...input } = slide;
    expect(slideSchema.safeParse(input).success).toBe(true);
    expect(slideSchema.safeParse({ ...input, buttonLabel: null }).success).toBe(false);
    expect(slideSchema.safeParse({ ...input, type: 'TEMPORARY' }).success).toBe(false);
    expect(slideSchema.safeParse({ ...input, type: 'TEMPORARY', published: false }).success).toBe(true);
    expect(slideSchema.safeParse({ ...input, startsAt: now.toISOString(), endsAt: now.toISOString() }).success).toBe(false);
    expect(slideSchema.safeParse({ ...input, content: 'FREE_DELIVERY' }).success).toBe(false);
  });
  it('uses an inclusive start and exclusive end, with draft and disabled states', () => {
    expect(slideStatus(slide, now)).toBe('ACTIVE');
    expect(slideStatus({ ...slide, published: false }, now)).toBe('DRAFT');
    expect(slideStatus({ ...slide, active: false }, now)).toBe('DISABLED');
    expect(slideStatus({ ...slide, startsAt: new Date(now.getTime() + 1) }, now)).toBe('SCHEDULED');
    expect(slideStatus({ ...slide, startsAt: now }, now)).toBe('ACTIVE');
    expect(slideStatus({ ...slide, endsAt: now }, now)).toBe('ENDED');
  });
  it('renders one real dynamic threshold and omits unavailable collections', () => {
    const conditions = { freeDeliveryThreshold: 300_050, seasonal: false, hits: false };
    const delivery = { ...slide, content: 'FREE_DELIVERY' as const, title: 'Бесплатная доставка от {threshold}', text: 'От {threshold}' };
    const rendered = renderSlide(delivery, conditions)!;
    expect(rendered.title).toContain('3'); expect(rendered.title).toContain('000,5');
    expect(rendered.title).not.toContain('{threshold}');
    expect(renderSlide(delivery, { ...conditions, freeDeliveryThreshold: null })).toBeNull();
    expect(renderSlide({ ...slide, content: 'SEASONAL' }, conditions)).toBeNull();
    expect(renderSlide({ ...slide, content: 'HITS' }, conditions)).toBeNull();
    expect(renderSlide({ ...slide, content: 'SEASONAL' }, { ...conditions, seasonal: true })?.to).toBe('/catalog?tag=seasonal');
    expect(renderSlide({ ...slide, content: 'HITS' }, { ...conditions, hits: true })?.to).toBe('/catalog?tag=hit');
  });
  it('refreshes both delivery texts from current settings without changing the stored template', () => {
    const template = { ...slide, content: 'FREE_DELIVERY' as const,
      title: 'Бесплатная доставка от {threshold}', text: 'Товары от {threshold}', image: '/images/hero/hero-1.webp' };
    const original = { ...template };
    const render = (freeDeliveryThreshold: number | null) => renderSlide(template, {
      freeDeliveryThreshold, seasonal: false, hits: false,
    });
    const first = render(220_000)!;
    const updated = render(330_050)!;
    expect(first.title).not.toEqual(updated.title);
    expect(first.text).not.toEqual(updated.text);
    expect(updated.title).toContain('3');
    expect(updated.title).toContain('300,5');
    expect(updated.title + updated.text).not.toContain('{threshold}');
    expect(updated.image).toBe(template.image);
    expect(updated.to).toBe('/catalog');
    expect(render(null)).toBeNull();
    expect(template).toEqual(original);
  });
});

describe('Managed seasonal and hit slide selections', () => {
  it.each([false, true])('renders live collections with a fixed query count: available=%s', async available => {
    const records = Array.from({ length: 30 }, (_, index) => ({ ...slide, id: index + 1,
      content: index % 2 ? 'SEASONAL' as const : 'HITS' as const,
    }));
    const tx = {
      homeSlide: { findMany: vi.fn().mockResolvedValue(records) },
      shopSettings: { findUniqueOrThrow: vi.fn().mockResolvedValue({ deliveryEnabled: true, freeDeliveryEnabled: false, freeDeliveryThreshold: null }) },
      product: { count: vi.fn().mockResolvedValue(available ? 1 : 0) },
    };
    const db = { $transaction: async (run: (client: typeof tx) => Promise<unknown>) => run(tx) } as unknown as DbService;
    const result = await new SlidesService(db).public();
    expect(result.slides).toHaveLength(available ? 30 : 0);
    expect(tx.homeSlide.findMany).toHaveBeenCalledTimes(1);
    expect(tx.product.count).toHaveBeenCalledTimes(2);
    expect(tx.product.count).toHaveBeenCalledWith({ where: expect.objectContaining({ active: true, category: { active: true }, AND: { OR: [{ hitMode: 'MANUAL' }, { hitMode: 'AUTO', isHit: true }] } }) });
    if (available) expect(result.slides.slice(0, 2).map(item => item.to)).toEqual(['/catalog?tag=hit', '/catalog?tag=seasonal']);
  });
});
