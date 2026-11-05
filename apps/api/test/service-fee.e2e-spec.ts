import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import pg from 'pg';

// Never fall back to DATABASE_URL: even a local working database is not a test target.
const databaseUrl = process.env.SERVICE_FEE_TEST_DATABASE_URL;
const migrationName = '20261103150000_global_service_fee';
const migrationRoot = resolve('prisma/migrations');
type Row = Record<string, unknown>;

describe.skipIf(!databaseUrl)('service fee foundation / dedicated PostgreSQL database', () => {
  let connection: pg.Client;
  let schema: string | undefined;
  let migration: string;

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !/^\/service_fee_test_[a-f0-9]{32}$/.test(url.pathname))
      throw new Error('A dedicated local service_fee_test_<uuid> database is required');
    connection = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
    await connection.connect();
    migration = await readFile(join(migrationRoot, migrationName, 'migration.sql'), 'utf8');
  });

  beforeEach(async () => {
    const candidate = `fee_${randomUUID().replaceAll('-', '')}`;
    if (!/^fee_[a-f0-9]{32}$/.test(candidate)) throw new Error('Unsafe test schema');
    await connection.query(`CREATE SCHEMA "${candidate}"`);
    schema = candidate; // Cleanup only schemas successfully created by this test.
    await connection.query(`SET search_path TO "${schema}"`);
    const entries = (await readdir(migrationRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && entry.name < migrationName)
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries)
      await connection.query(await readFile(join(migrationRoot, entry.name, 'migration.sql'), 'utf8'));
    await fixtures();
  }, 60000);

  afterEach(async () => {
    if (!connection) return;
    await connection.query('ROLLBACK');
    if (schema && /^fee_[a-f0-9]{32}$/.test(schema)) {
      await connection.query(`DROP SCHEMA "${schema}" CASCADE`);
      schema = undefined;
    }
  });
  afterAll(async () => { await connection?.end(); });

  async function fixtures() {
    await connection.query(`
      INSERT INTO "User" (id, role, "updatedAt") VALUES
        (-1, 'ADMIN', '2026-10-20'), (-2, 'USER', '2026-10-20');
      INSERT INTO "Category" (id, name, slug, "updatedAt")
        VALUES (-1, 'Migration fixture', 'fee-fixture', '2026-10-20');
      INSERT INTO "Product" (id, name, slug, price, unit, "priceQty", min, step, "portionQty",
        "categoryId", "serviceMarkupPercent", "updatedAt")
      SELECT percent + 1, 'Fee fixture ' || percent, 'fee-fixture-' || percent,
        10005 + percent, CASE WHEN percent % 2 = 0 THEN 'GRAM'::"Unit" ELSE 'PIECE'::"Unit" END,
        CASE WHEN percent % 2 = 0 THEN 1000 ELSE 1 END, 1, 1, 1, -1, percent, '2026-10-20'
      FROM generate_series(0, 100) AS percent;
      INSERT INTO "GuestSession" (id, "tokenHash", "expiresAt")
        VALUES ('fee-guest', 'fee-guest-hash', '2030-01-01');
      INSERT INTO "Order" (id, type, status, "customerName", "customerPhone", "userId", "guestSessionId",
        subtotal, "deliveryPrice", total, "finalSubtotal", "finalTotal", "updatedAt", "completedAt") VALUES
        (-1, 'DELIVERY', 'COMPLETED', 'Fixture', '+79990000000', -2, NULL,
          11000, 1000, 12000, 12636, 13636, '2026-10-20', '2026-10-20'),
        (-2, 'PICKUP', 'CANCELED', 'Guest fixture', '+79990000001', NULL, 'fee-guest',
          20000, 0, 20000, NULL, NULL, '2026-10-20', NULL);
      INSERT INTO "OrderItem" (id, "productName", "productSlug", price, "actualPrice", "priceQty", unit,
        qty, "actualQty", total, "actualTotal", status, "orderId", "productId", "serviceMarkupPercentSnapshot",
        "settlementModeSnapshot", "basePriceSnapshot") VALUES
        (-1, 'Historical fixture', 'historical-fixture', 11000, 12100, 1000, 'GRAM',
          1000, 1003, 11000, 12136, 'PICKED', -1, 1, 10, 'SHARED_MARKUP', 10000),
        (-2, 'Legacy fixture', 'legacy-fixture', 20000, NULL, 1, 'PIECE',
          1, 0, 20000, 0, 'MISSING', -2, 2, NULL, NULL, NULL);
      INSERT INTO "OrderPayment" (id, "orderId", amount, status, method, "confirmedById", "confirmedAt", "updatedAt")
        VALUES (-1, -1, 12636, 'PAID', 'SBP', -1, '2026-10-20', '2026-10-20');
      INSERT INTO "Delivery" (id, provider, status, price, "publicToken", "orderId", "updatedAt")
        VALUES (-1, 'OTHER', 'DELIVERED', 1000, 'fee-delivery-token', -1, '2026-10-20');
      INSERT INTO "OrderExtra" (id, "orderId", title, quantity, "unitPrice", amount, "createdById", "updatedAt")
        VALUES (-1, -1, 'Fixture extra', 1, 500, 500, -1, '2026-10-20');
      INSERT INTO "PromoCode" (id, code, title, "userId", type, amount, "expiresAt", reason, "issuedById",
        status, "usedAt", "usedOrderId", "updatedAt")
        VALUES (-1, 'FEE-FIXTURE', 'Fixture promo', -2, 'FIXED', 500, '2030-01-01', 'Fixture', -1,
          'USED', '2026-10-20', -1, '2026-10-20');
      UPDATE "Order" SET "promoCodeId" = -1, "promoCodeSnapshot" = 'FEE-FIXTURE',
        "promoTypeSnapshot" = 'FIXED', "promoAmountSnapshot" = 500, "promoDiscount" = 500,
        "finalPromoDiscount" = 500, "finalTotal" = 13136 WHERE id = -1;
      INSERT INTO "OrderItemPriceChange" (id, "orderId", "itemId", "requestId", "previousPrice", "newPrice", "sellerPrice", "actorId")
        VALUES (-1, -1, -1, '11111111-1111-4111-8111-111111111111', 11000, 12100, 11000, -1);
      INSERT INTO "OrderCancellation" (id, "orderId", "fromStatus", "canceledById", "canceledByRole", reason)
        VALUES (-1, -2, 'NEW', -2, 'USER', 'Fixture');
      INSERT INTO "AdminAudit" ("actorId", action, entity, "entityId", "oldValue", "newValue")
        VALUES (-1, 'PRODUCT_MARKUP_CHANGED', 'PRODUCT', '11', '15', '10');
    `);
  }

  async function snapshot() {
    const tables = await connection.query<{ tablename: string }>(
      'SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename', [schema]);
    const result: Record<string, Row[]> = {};
    for (const { tablename } of tables.rows) {
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(tablename)) throw new Error('Unsafe fixture table');
      result[tablename] = (await connection.query<{ row: Row }>(
        `SELECT to_jsonb(t) AS row FROM "${tablename}" t ORDER BY to_jsonb(t)::text`)).rows.map(row => row.row);
    }
    return result;
  }

  async function normalizedColumn() {
    return (await connection.query(`
      SELECT a.attnum, a.attgenerated, pg_get_expr(d.adbin, d.adrelid) AS expression
      FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = '"Product"'::regclass AND a.attname = 'normalizedPrice'
    `)).rows;
  }

  it('preserves all 101 percentages, every old product field and all other table rows', async () => {
    const before = await snapshot();
    const column = await normalizedColumn();
    const index = (await connection.query('SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = $2',
      [schema, 'Product_normalizedPrice_name_id_idx'])).rows;
    const sorted = (await connection.query('SELECT id FROM "Product" ORDER BY "normalizedPrice", name, id')).rows;
    await connection.query(migration);
    const after = await snapshot();
    const byId = (rows: Row[]) => rows.toSorted((a, b) => Number(a.id) - Number(b.id));
    expect(byId(after.Product)).toEqual(byId(before.Product.map(row => ({ ...row,
      serviceMarkupPercentOverride: row.serviceMarkupPercent,
      serviceMarkupNeedsReview: row.serviceMarkupPercent === 10,
    }))));
    expect(after.ShopSettings).toEqual(before.ShopSettings.map(row => ({ ...row, globalServiceMarkupPercent: 10 })));
    for (const table of Object.keys(before).filter(table => !['Product', 'ShopSettings'].includes(table)))
      expect(after[table], table).toEqual(before[table]);
    expect(await normalizedColumn()).toEqual(column);
    expect((await connection.query('SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = $2',
      [schema, 'Product_normalizedPrice_name_id_idx'])).rows).toEqual(index);
    expect((await connection.query('SELECT id FROM "Product" ORDER BY "normalizedPrice", name, id')).rows).toEqual(sorted);
  });

  it('defaults new products to null override without enabling global repricing', async () => {
    await connection.query(migration);
    const before = (await connection.query('SELECT id, price, "serviceMarkupPercent", "normalizedPrice" FROM "Product" ORDER BY id')).rows;
    await connection.query('UPDATE "ShopSettings" SET "globalServiceMarkupPercent" = 25');
    expect((await connection.query('SELECT id, price, "serviceMarkupPercent", "normalizedPrice" FROM "Product" ORDER BY id')).rows).toEqual(before);
    const result = await connection.query(`
      INSERT INTO "Product" (id, name, slug, price, unit, "priceQty", min, step, "portionQty", "categoryId", "updatedAt")
      VALUES (102, 'New fixture', 'new-fee-fixture', 10000, 'PIECE', 1, 1, 1, 1, -1, '2026-10-20')
      RETURNING "serviceMarkupPercentOverride", "serviceMarkupNeedsReview", "serviceMarkupPercent", "normalizedPrice"
    `);
    expect(result.rows[0]).toEqual({ serviceMarkupPercentOverride: null, serviceMarkupNeedsReview: false,
      serviceMarkupPercent: 10, normalizedPrice: '11000.000000000000' });
  });

  it('enforces global and nullable override bounds in PostgreSQL', async () => {
    await connection.query(migration);
    for (const percent of [0, 100]) {
      await connection.query('UPDATE "ShopSettings" SET "globalServiceMarkupPercent" = $1', [percent]);
      await connection.query('UPDATE "Product" SET "serviceMarkupPercentOverride" = $1 WHERE id = 1', [percent]);
    }
    await connection.query('UPDATE "Product" SET "serviceMarkupPercentOverride" = NULL WHERE id = 1');
    for (const percent of [-1, 101]) {
      await expect(connection.query('UPDATE "ShopSettings" SET "globalServiceMarkupPercent" = $1', [percent]))
        .rejects.toMatchObject({ code: '23514' });
      await expect(connection.query('UPDATE "Product" SET "serviceMarkupPercentOverride" = $1 WHERE id = 1', [percent]))
        .rejects.toMatchObject({ code: '23514' });
    }
    await expect(connection.query('UPDATE "ShopSettings" SET "globalServiceMarkupPercent" = NULL'))
      .rejects.toMatchObject({ code: '23502' });
  });

  it.each([-1, 101, null])('aborts atomically on legacy percentage %s before adding columns', async percent => {
    // Simulate an inconsistent local database whose old safeguard was removed.
    await connection.query('ALTER TABLE "Product" DROP CONSTRAINT "Product_markup_check"');
    if (percent === null) {
      await connection.query('ALTER TABLE "Product" ALTER COLUMN "serviceMarkupPercent" DROP NOT NULL');
      await connection.query('ALTER TABLE "Product" ALTER COLUMN "normalizedPrice" DROP NOT NULL');
    }
    await connection.query('UPDATE "Product" SET "serviceMarkupPercent" = $1 WHERE id = 1', [percent]);
    const before = await snapshot();
    await expect(connection.query(migration)).rejects.toMatchObject({ code: 'P0001' });
    await connection.query('ROLLBACK');
    expect(await snapshot()).toEqual(before);
    const columns = await connection.query(`
      SELECT column_name FROM information_schema.columns WHERE table_schema = $1
      AND column_name IN ('globalServiceMarkupPercent', 'serviceMarkupPercentOverride', 'serviceMarkupNeedsReview')
    `, [schema]);
    expect(columns.rows).toEqual([]);
  });
});
