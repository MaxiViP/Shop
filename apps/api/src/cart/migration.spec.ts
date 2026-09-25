import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
it('shopping migration only adds cart tables and widens the existing customer session safely', () => {
  const sql = readFileSync(
    resolve('prisma/migrations/20260925120000_customer_shopping/migration.sql'),
    'utf8',
  );
  expect(sql.trim().startsWith('BEGIN;')).toBe(true);
  expect(sql.trim().endsWith('COMMIT;')).toBe(true);
  expect(sql).not.toMatch(
    /DROP TABLE|TRUNCATE|DELETE FROM|ALTER TYPE|UPDATE "(Order|User|OrderPayment)"/i,
  );
  expect(sql).toContain('CREATE UNIQUE INDEX "Cart_userId_key"');
  expect(sql).toContain('PRIMARY KEY ("cartId", "productId")');
  expect(sql).toContain('CHECK ("qty" > 0 AND "qty" <= 1000000)');
  expect(sql).toContain('ALTER COLUMN "orderId" DROP NOT NULL');
  expect(sql).toContain('ADD COLUMN "payload" JSONB');
  expect(sql).toContain('ADD CONSTRAINT "CustomerTelegramSession_state_check"');
  expect(sql).not.toMatch(/price|token|secret|password/i);
});
