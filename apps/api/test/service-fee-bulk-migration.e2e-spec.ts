import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import pg from 'pg';

const target = process.env.SERVICE_FEE_TEST_DATABASE_URL;
const schema = 'fee_bulk_migration_' + randomUUID().replaceAll('-', '');
const migration = '20261104090000_service_fee_bulk_operation';

describe.skipIf(!target)(
  'bulk operation additive migration / isolated PostgreSQL',
  () => {
    let db: pg.Client, before: unknown, expression: unknown;
    async function snapshot() {
      const state: Record<string, unknown> = {};
      for (const table of [
        'Product',
        'ShopSettings',
        'Order',
        'OrderItem',
        'OrderPayment',
        'AdminAudit',
      ])
        state[table] = (
          await db.query(
            `SELECT to_jsonb(t) AS row FROM "${table}" t ORDER BY id`,
          )
        ).rows;
      return state;
    }
    const generated = async () =>
      (
        await db.query(
          `SELECT a.attgenerated, pg_get_expr(d.adbin,d.adrelid) AS expression
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE n.nspname=$1 AND c.relname='Product' AND a.attname='normalizedPrice'`,
          [schema],
        )
      ).rows;
    beforeAll(async () => {
      const url = new URL(target!);
      if (
        url.hostname !== '127.0.0.1' ||
        !/^\/service_fee_test_[a-f0-9]{32}$/.test(url.pathname) ||
        url.search
      )
        throw new Error('Explicit isolated local test database required');
      db = new pg.Client({ connectionString: target });
      await db.connect();
      await db.query(`CREATE SCHEMA "${schema}"`);
      await db.query(`SET search_path TO "${schema}"`);
      const root = resolve('prisma/migrations');
      for (const entry of (await readdir(root, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name === migration) break;
        await db.query(
          await readFile(join(root, entry.name, 'migration.sql'), 'utf8'),
        );
      }
      await db.query(`
      INSERT INTO "User" (id,role,phone,"updatedAt") VALUES (1,'ADMIN','+79990000887',NOW());
      INSERT INTO "Category" (id,name,slug,"updatedAt") VALUES (1,'Fixture','fixture',NOW());
      INSERT INTO "Product" (id,name,slug,price,unit,"portionQty","categoryId","serviceMarkupPercent","serviceMarkupPercentOverride","updatedAt")
      SELECT id,'Product '||id,'product-'||id,10005,'PIECE',1,1,p,p,NOW() FROM (VALUES (1,0),(2,10),(3,20),(4,100)) p(id,p);
      INSERT INTO "Order" (id,type,status,"customerName","customerPhone",subtotal,"deliveryPrice",total,"finalSubtotal","finalTotal","updatedAt")
      VALUES (1,'PICKUP','COMPLETED','Historical','+79990000000',11006,0,11006,11006,11006,NOW());
      INSERT INTO "OrderItem" (id,"productName","productSlug",price,"priceQty",unit,qty,total,"orderId","productId","serviceMarkupPercentSnapshot")
      VALUES (1,'Historical','historical',11006,1,'PIECE',1,11006,1,2,10);
      INSERT INTO "OrderPayment" (id,"orderId",amount,status,"updatedAt") VALUES (1,1,11006,'PAID',NOW());
    `);
      before = await snapshot();
      expression = await generated();
      await db.query(
        await readFile(join(root, migration, 'migration.sql'), 'utf8'),
      );
    }, 60000);
    afterAll(async () => {
      if (db) {
        await db.query('ROLLBACK');
        await db.query(`DROP SCHEMA "${schema}" CASCADE`);
        await db.end();
      }
    });
    it('does not alter any existing products, settings, history or audit', async () => {
      expect(await snapshot()).toEqual(before);
    });
    it('keeps the stored generated normalizedPrice expression intact', async () => {
      expect(await generated()).toEqual(expression);
      expect(expression).toMatchObject([{ attgenerated: 's' }]);
    });
    it('starts with an empty idempotency table', async () => {
      expect(
        (
          await db.query(
            'SELECT count(*)::int AS count FROM "ServiceFeeBulkOperation"',
          )
        ).rows[0].count,
      ).toBe(0);
    });
    it('enforces UUID uniqueness, actor FK and valid durable results', async () => {
      const id = randomUUID();
      const insert = (
        requestId: string,
        actorId: number,
        hash: string,
        result: string,
      ) =>
        db.query(
          'INSERT INTO "ServiceFeeBulkOperation" ("requestId","actorId","previewHash",result) VALUES ($1,$2,$3,$4)',
          [requestId, actorId, hash, result],
        );
      await insert(id, 1, 'a'.repeat(64), '{}');
      await expect(insert(id, 1, 'a'.repeat(64), '{}')).rejects.toMatchObject({
        code: '23505',
      });
      await expect(
        insert(randomUUID(), 999, 'a'.repeat(64), '{}'),
      ).rejects.toMatchObject({ code: '23503' });
      await expect(
        insert(randomUUID(), 1, 'wrong', '{}'),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        insert(randomUUID(), 1, 'a'.repeat(64), '[]'),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        db.query('DELETE FROM "User" WHERE id=1'),
      ).rejects.toMatchObject({ code: '23001' });
    });
  },
);
