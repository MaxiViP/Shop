import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseResearch,
  readResearch,
  rublesToKopecks,
  type Research,
} from '../data/bagrationovsky/input.js';
import {
  planImport,
  queueSchema,
  readQueue,
  saveQueue,
  type Snapshot,
} from '../data/bagrationovsky/queue.js';

let research: Research;
beforeAll(async () => {
  research = await readResearch();
});
const validate = (value: Research) =>
  parseResearch(value.stores, value.myasberry, value.bylinkino);

describe('Bagrationovsky research staging', () => {
  it('retains every online source ID, all twelve possible duplicate groups and source name corrections', () => {
    const { queue, preview } = planImport(research, null);
    expect(preview.summary).toMatchObject({
      stores: { createDrafts: 16 },
      products: { createDrafts: 168 },
      myasberryReferences: 128,
      bylinkinoUnknownPrices: 40,
      potentialDuplicateGroups: 12,
      mergedSourceOffers: 0,
    });
    expect(new Set(queue.products.map((row) => row.key)).size).toBe(168);
    for (const group of research.duplicateGroups) {
      expect(group.sameObservedPriceAndBasis).toBe(true);
      expect(group.confirmedSameSku).toBe(false);
      for (const id of group.sourceItemIds)
        expect(
          queue.products.some((row) => row.source.sourceItemId === id),
        ).toBe(true);
    }
    expect(queue.products[0].source).toMatchObject({
      name: 'Равиоли «Классические»',
      sourceName: 'Равиоли "Классические',
      sku: null,
    });
    expect(queue.products[0].source.displayNameCorrections).toHaveLength(1);
  });

  it('keeps integer kopecks for the exact source mass without creating a sale price, markup or package weight', () => {
    const { queue } = planImport(research, null);
    expect(queue.products[0].source.referencePrice).toMatchObject({
      amountKopecks: 69300,
      unit: 'GRAM',
      priceQty: 500,
      scope: 'MOSCOW_OFFICIAL_ONLINE_CATALOG_REFERENCE',
      checkedOn: '2026-10-11',
    });
    expect(
      [
        ...new Set(
          queue.products.flatMap((row) =>
            row.source.referencePrice
              ? [row.source.referencePrice.priceQty]
              : [],
          ),
        ),
      ].sort((a, b) => a - b),
    ).toEqual([300, 400, 450, 500, 600, 800, 1000]);
    for (const row of queue.products)
      expect(row).toMatchObject({
        source: {
          netWeightGrams: null,
          sku: null,
          description: null,
          stockStatus: 'UNKNOWN',
        },
        sale: {
          confirmedPriceKopecks: null,
          unit: null,
          active: false,
          markupPercent: null,
        },
      });
    expect(JSON.stringify(queue)).not.toContain('customerPrice');
    expect(queue).toMatchObject({
      customerVisible: false,
      orderable: false,
      readyForDatabaseImport: false,
    });
  });

  it('preserves the forty unknown prices and distinct milk variants without fabricating identifiers or sale units', () => {
    const { queue } = planImport(research, null);
    const rows = queue.products.filter(
      (row) => row.source.supplierKey === 'bylinkino',
    );
    expect(rows).toHaveLength(40);
    for (const row of rows)
      expect(row).toMatchObject({
        source: {
          sourceItemId: null,
          referencePrice: null,
          sku: null,
          description: null,
          stockStatus: 'UNKNOWN',
          netWeightGrams: null,
        },
        sale: { confirmedPriceKopecks: null, unit: null },
      });
    const variants = rows.filter((row) => row.source.name === 'Белый трюфель');
    expect(variants.map((row) => row.source.milkType).sort()).toEqual([
      'Козье',
      'Коровье',
    ]);
    expect(new Set(variants.map((row) => row.key)).size).toBe(2);
    const reordered = structuredClone(research);
    reordered.bylinkino.items.reverse();
    expect(
      new Set(planImport(reordered, null).queue.products.map((row) => row.key)),
    ).toEqual(new Set(queue.products.map((row) => row.key)));
  });

  it('shows name, pavilion and hypothesis evidence without binding any candidate to a live point/product', () => {
    const snapshot: Snapshot = {
      points: [
        {
          id: 50,
          slug: 'artisan-cheese',
          name: 'Былинкино',
          floor: 2,
          unitNumber: 'В-12',
          isPublished: true,
        },
      ],
      products: [],
    };
    const result = planImport(research, snapshot);
    expect(
      result.preview.stores.find((row) => row.researchKey === 'bylinkino')
        ?.candidates[0],
    ).toMatchObject({
      id: 50,
      evidence: ['name', 'pavilion', 'hypothesis'],
      confirmed: false,
    });
    for (const row of result.queue.stores)
      expect(row.review.marketPointId).toBeNull();
    for (const row of result.queue.products)
      expect(row.review.productId).toBeNull();
    expect(result.preview.liveDatabaseWrites).toBe(0);
  });

  it('reuses queued rows and preserves explicit reviewer decisions across reruns', () => {
    const first = planImport(research, null).queue;
    first.products[0].review = {
      status: 'VERIFIED',
      marketPointId: 7,
      productId: 11,
      confirmedSku: 'SELLER-123',
      reviewedOn: '2026-10-11',
      notes: 'Проверено вручную',
    };
    first.stores[0].review.notes = 'Вывеску нужно сверить';
    const repeat = planImport(research, null, first);
    expect(repeat.queue).toEqual(first);
    expect(repeat.preview.summary).toMatchObject({
      stores: { createDrafts: 0, keepDrafts: 16 },
      products: { createDrafts: 0, keepDrafts: 168 },
    });
  });

  it('reports changed evidence and removed source rows without overwriting old evidence or manual decisions', () => {
    const old = planImport(research, null).queue;
    old.products[0].review.notes = 'Ручная проверка';
    const changed = structuredClone(research);
    Object.assign(changed.myasberry.offers[0], {
      sourcePriceRubles: 694,
      sourcePriceKopecks: 69400,
      sourcePriceText: '694R RUB 500 г',
    });
    changed.bylinkino.items.pop();
    changed.bylinkino.itemCount--;
    const result = planImport(validate(changed), null, old);
    expect(result.queue.products).toHaveLength(168);
    expect(result.queue.products[0]).toEqual(old.products[0]);
    expect(result.preview.products[0]).toMatchObject({
      action: 'review_source_change',
      incomingSource: { referencePrice: { amountKopecks: 69400 } },
    });
    expect(result.preview.summary.products.changedSources).toBe(2);
  });

  it('rejects inconsistent money, source text, unit masses and duplicate/source ID declarations', () => {
    for (const field of [
      'kopecks',
      'text',
      'mass',
      'sourceId',
      'duplicateGroup',
    ] as const) {
      const invalid = structuredClone(research);
      if (field === 'kopecks') invalid.myasberry.offers[0].sourcePriceKopecks++;
      if (field === 'text')
        invalid.myasberry.offers[0].sourcePriceText = '693R RUB 1 кг';
      if (field === 'mass')
        invalid.myasberry.offers[0].sourcePriceBasis.massGrams = 1000;
      if (field === 'sourceId')
        invalid.myasberry.offers[1].sourceItemId =
          invalid.myasberry.offers[0].sourceItemId;
      if (field === 'duplicateGroup')
        invalid.myasberry.potentialDuplicates[0].sourceItemIds[0] =
          'NOT-A-SOURCE-ID';
      expect(() => validate(invalid)).toThrow();
    }
    const unknown = structuredClone(research);
    Object.assign(unknown.bylinkino.items[0], { retailStallPriceRubles: 0 });
    expect(() => validate(unknown)).toThrow();
    const publishing = structuredClone(research);
    Object.assign(publishing.stores.additionalNames[0], {
      allowAutomaticPublish: true,
    });
    expect(() => validate(publishing)).toThrow();
    const queue = planImport(research, null).queue;
    queue.products[0].source.referencePrice!.priceQty = 1000;
    expect(() => queueSchema.parse(queue)).toThrow('Масса ценовой базы');
    queue.products[0].source.referencePrice!.priceQty = 500;
    Object.assign(queue.products[0].sale, { confirmedPriceKopecks: 0 });
    expect(() => queueSchema.parse(queue)).toThrow();
  });

  it('converts decimal reference amounts with integer arithmetic and rejects fractional kopecks', () => {
    expect(rublesToKopecks(693)).toBe(69300);
    expect(rublesToKopecks('0,29')).toBe(29);
    expect(rublesToKopecks('19.99')).toBe(1999);
    for (const value of [0, -1, '1.001', 'Infinity'])
      expect(() => rublesToKopecks(value)).toThrow();
  });
});

describe('Bagrationovsky file queue and CLI', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'shop-bagrationovsky-test-'));
  });
  afterEach(async () => {
    if (
      !resolve(directory).startsWith(resolve(tmpdir()) + sep) ||
      !basename(directory).startsWith('shop-bagrationovsky-test-')
    )
      throw new Error('Unsafe test directory');
    await rm(directory, { recursive: true, force: true });
  });

  it('writes atomically, performs no identical second write and detects concurrent manual edits', async () => {
    const file = join(directory, 'queue.json');
    const queue = planImport(research, null).queue;
    expect(await saveQueue(file, queue, undefined)).toBe(true);
    const text = await readQueue(file);
    const before = await stat(file);
    expect(await saveQueue(file, queue, text)).toBe(false);
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
    const manual = structuredClone(queue);
    manual.stores[0].review.notes = 'Изменено во время просмотра';
    await writeFile(file, JSON.stringify(manual));
    await expect(saveQueue(file, queue, text)).rejects.toThrow(
      'Очередь изменена',
    );
    expect(JSON.parse((await readQueue(file))!)).toEqual(manual);
  });

  it('CLI dry-run leaves the queue absent; prepare is idempotent and --apply is rejected', async () => {
    const file = join(directory, 'queue.json');
    const report = join(directory, 'report.json');
    const run = (mode: string) =>
      spawnSync(
        process.execPath,
        [
          fileURLToPath(
            new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url),
          ),
          'data/bagrationovsky/run.ts',
          mode,
          '--offline',
          `--queue=${file}`,
          `--report=${report}`,
        ],
        {
          cwd: fileURLToPath(new URL('../', import.meta.url)),
          encoding: 'utf8',
          windowsHide: true,
          timeout: 15_000,
        },
      );
    expect(run('--dry-run').status).toBe(0);
    expect(await readQueue(file)).toBeUndefined();
    expect(JSON.parse(await readFile(report, 'utf8'))).toMatchObject({
      mode: 'dry_run',
      databaseMatched: false,
      liveDatabaseWrites: 0,
      queueWritten: false,
    });
    expect(run('--prepare').status).toBe(0);
    const first = await readQueue(file);
    expect(run('--prepare').status).toBe(0);
    expect(await readQueue(file)).toBe(first);
    expect(JSON.parse(await readFile(report, 'utf8'))).toMatchObject({
      queueWritten: false,
      summary: {
        stores: { createDrafts: 0, keepDrafts: 16 },
        products: { createDrafts: 0, keepDrafts: 168 },
      },
    });
    expect(run('--apply').status).toBe(1);
    expect(await readQueue(file)).toBe(first);
  }, 30_000);
});
