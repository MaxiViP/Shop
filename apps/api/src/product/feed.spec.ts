import { feedScope, readFeedCursor } from './feed.js';
import { productQuerySchema } from './schema.js';

describe('product feed validation', () => {
  it('bounds feed pages while retaining the existing paged API', () => {
    expect(productQuerySchema.safeParse({ feed: 'catalog', limit: 25 }).success).toBe(false);
    expect(productQuerySchema.safeParse({ feed: 'home', page: 2 }).success).toBe(false);
    expect(productQuerySchema.safeParse({ cursor: 'abc' }).success).toBe(false);
    expect(productQuerySchema.safeParse({ seed: 'nope', feed: 'home' }).success).toBe(false);
    expect(productQuerySchema.parse({ page: 2, limit: 60 })).toMatchObject({ page: 2, limit: 60 });
  });

  it('binds a cursor to all filters and sorting, independently of page size and ID order', () => {
    const query = productQuerySchema.parse({ feed: 'catalog', ids: '2,1', q: ' яблоко ', category: 'fruits' });
    expect(feedScope(query)).toBe(feedScope({ ...query, ids: [1, 2], limit: 8 }));
    for (const changed of [{ q: 'груша' }, { category: 'greens' }, { marketPoint: 'stall' }, { sort: 'name' as const }])
      expect(feedScope({ ...query, ...changed })).not.toBe(feedScope(query));
  });

  it('returns a safe HTTP error for malformed and mismatched cursors', () => {
    const query = productQuerySchema.parse({ feed: 'catalog' });
    expect(() => readFeedCursor({ ...query, cursor: Buffer.from('{}').toString('base64url') })).toThrow('Некорректная страница');
    expect(() => readFeedCursor({ ...query, cursor: Buffer.from('not json').toString('base64url') })).toThrow('Некорректная страница');
  });
});
