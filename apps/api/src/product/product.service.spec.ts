import { DbService } from '../db/db.service.js';
import { productQuerySchema } from './schema.js';
import { ProductService } from './product.service.js';

function setup(items: object[] = [], total = items.length) {
  const findMany = vi.fn().mockResolvedValue(items);
  const count = vi.fn().mockResolvedValue(total);
  const db = {
    product: { findMany, count },
    $transaction: vi.fn((queries: Promise<unknown>[]) => Promise.all(queries)),
  } as unknown as DbService;

  return { count, findMany, service: new ProductService(db) };
}

function query(value: unknown = {}) {
  return productQuerySchema.parse(value);
}

describe('ProductService list', () => {
  it('lists active products without a search query', async () => {
    const { count, findMany, service } = setup([{ id: 1 }], 1);

    const result = await service.list(query());

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ active: true, OR: undefined }),
      }),
    );
    expect(count).toHaveBeenCalledWith({
      where: expect.objectContaining({ active: true, OR: undefined }),
    });
    expect(result.items).toEqual([{ id: 1 }]);
  });

  it.each([
    ['name', 'авокадо'],
    ['description', 'спелый плод'],
    ['case-insensitive name', 'АВОКАДО'],
  ])('searches by %s', async (_field, search) => {
    const { findMany, service } = setup();

    await service.list(query({ q: search }));

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          active: true,
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { description: { contains: search, mode: 'insensitive' } },
          ],
        }),
      }),
    );
  });

  it('normalizes whitespace and combines category with search', async () => {
    const { findMany, service } = setup();

    await service.list(query({ category: ' fruits ', q: '  спелый   плод  ' }));

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          active: true,
          category: { slug: 'fruits' },
          OR: [
            { name: { contains: 'спелый плод', mode: 'insensitive' } },
            {
              description: {
                contains: 'спелый плод',
                mode: 'insensitive',
              },
            },
          ],
        }),
      }),
    );
  });

  it.each([
    ['recommended', [{ sort: 'asc' }, { name: 'asc' }]],
    ['price_asc', [{ price: 'asc' }, { name: 'asc' }]],
    ['price_desc', [{ price: 'desc' }, { name: 'asc' }]],
    ['newest', [{ createdAt: 'desc' }, { name: 'asc' }]],
    ['name', [{ name: 'asc' }]],
  ] as const)('applies %s sorting', async (sort, orderBy) => {
    const { findMany, service } = setup();

    await service.list(query({ sort }));

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ orderBy }));
  });

  it('returns pagination metadata and applies skip/take', async () => {
    const { findMany, service } = setup([{ id: 25 }], 49);

    const result = await service.list(query({ page: '2', limit: '24' }));

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 24, take: 24 }),
    );
    expect(result).toMatchObject({
      total: 49,
      page: 2,
      limit: 24,
      pages: 3,
    });
  });
});

describe('productQuerySchema', () => {
  it('treats an empty search as absent', () => {
    expect(query({ q: '   ' }).q).toBeUndefined();
  });

  it('rejects invalid sort and unsafe pagination', () => {
    expect(productQuerySchema.safeParse({ sort: 'popular' }).success).toBe(
      false,
    );
    expect(productQuerySchema.safeParse({ page: 0 }).success).toBe(false);
    expect(productQuerySchema.safeParse({ limit: 61 }).success).toBe(false);
    expect(productQuerySchema.safeParse({ q: 'x'.repeat(101) }).success).toBe(
      false,
    );
    expect(productQuerySchema.safeParse({ unknown: 'field' }).success).toBe(
      false,
    );
  });

  it('parses and deduplicates a bounded product ids filter', () => {
    expect(query({ ids: '3,1,3' }).ids).toEqual([3, 1]);
    expect(productQuerySchema.safeParse({ ids: '1,nope' }).success).toBe(false);
  });
});
