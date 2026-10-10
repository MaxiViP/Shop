import type { Prisma, SeasonTemplate } from '../db/gen/client.js';
import { fillSeasonPresets, seasonPresets } from './season-presets.js';
import { seasonalActive } from '../product/badges.js';

function fixture(initial: SeasonTemplate[] = []) {
  const saved = initial.map(row => ({ ...row }));
  const model = {
    findMany: vi.fn(async () => saved.map(row => ({ ...row }))),
    update: vi.fn(async ({ where, data }: { where: { id: number }; data: Partial<SeasonTemplate> }) => {
      const row = saved.find(row => row.id === where.id)!; Object.assign(row, data); return row;
    }),
    createMany: vi.fn(async ({ data }: { data: typeof seasonPresets }) => {
      for (const row of data) saved.push({ ...row, id: saved.length + 1, createdAt: new Date(0), updatedAt: new Date(0) });
      return { count: data.length };
    }),
  };
  return { saved, model, db: { seasonTemplate: model } as unknown as Prisma.TransactionClient };
}
describe('Moscow market season presets', () => {
  it('contains all 36 unique presets in the three groups and a wrapped mandarin season', () => {
    expect(seasonPresets).toHaveLength(36);
    expect(new Set(seasonPresets.map(row => row.key)).size).toBe(36);
    expect(new Set(seasonPresets.map(row => row.name)).size).toBe(36);
    expect(['VEGETABLES', 'FRUITS', 'BERRIES'].map(group => seasonPresets.filter(row => row.group === group).length)).toEqual([12, 13, 11]);
    const mandarin = seasonPresets.find(row => row.key === 'moscow-mandarins')!;
    expect(mandarin).toMatchObject({ startMonth: 11, endMonth: 1 });
    const product = { seasonalMode: 'AUTO' as const, seasonTemplate: mandarin };
    for (const at of ['2026-10-31T21:00:00Z', '2026-12-31T21:00:00Z', '2027-11-01T00:00:00Z'])
      expect(seasonalActive(product, new Date(at))).toBe(true);
    expect(seasonalActive(product, new Date('2027-01-31T21:00:00Z'))).toBe(false);
  });
  it('fills in one batch, then preserves renamed, inactive and edited presets', async () => {
    const { saved, model, db } = fixture();
    expect(await fillSeasonPresets(db)).toMatchObject({ created: 36 });
    Object.assign(saved[0]!, { name: 'Редис конкретной партии', description: 'Авторское описание', startMonth: 3, endMonth: 9, active: false });
    const edited = saved.map(row => ({ ...row }));
    expect(await fillSeasonPresets(db)).toMatchObject({ created: 0, skipped: 36 });
    expect(saved).toEqual(edited);
    expect(model.findMany).toHaveBeenCalledTimes(2);
    expect(model.createMany).toHaveBeenCalledTimes(1);
    expect(model.update).not.toHaveBeenCalled();
  });
  it('adopts a matching name without replacing content, IDs or timestamps', async () => {
    const original: SeasonTemplate = { id: 1, key: null, name: '  РЕДИС ', description: 'Местный урожай', group: null,
      startMonth: 4, endMonth: 8, active: false, createdAt: new Date(0), updatedAt: new Date(1) };
    const { saved, db } = fixture([original]);
    expect(await fillSeasonPresets(db)).toMatchObject({ created: 35, matched: 1 });
    expect(saved[0]).toEqual({ ...original, key: 'moscow-radish' });
    saved[0]!.name = 'Изменено администратором';
    expect(await fillSeasonPresets(db)).toMatchObject({ created: 0 });
    expect(saved).toHaveLength(36);
  });
});
