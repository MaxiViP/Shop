import { readFileSync } from 'node:fs';

const sql = readFileSync(new URL('../../prisma/migrations/20260924120000_customer_bot_v2/migration.sql', import.meta.url), 'utf8');
it('migration preserves existing SMS meaning and replaces only the dedupe index', () => {
  expect(sql).toContain('"channel" "NotificationChannel" NOT NULL DEFAULT \'SMS\'');
  expect(sql).toContain('("channel", "dedupeKey")');
  expect(sql.indexOf('CREATE UNIQUE INDEX "OrderNotification_channel_dedupeKey_key"'))
    .toBeLessThan(sql.indexOf('DROP INDEX "OrderNotification_dedupeKey_key"'));
  expect(sql).not.toMatch(/DROP TABLE|TRUNCATE|DELETE FROM|UPDATE "User"|ALTER COLUMN/i);
  expect(sql.trim().startsWith('BEGIN;')).toBe(true);
  expect(sql.trim().endsWith('COMMIT;')).toBe(true);
});
it('customer session is independent and notification deletion cannot delete chat history', () => {
  expect(sql).toContain('REFERENCES "TelegramIdentity"("id") ON DELETE CASCADE');
  expect(sql).not.toContain('REFERENCES "StaffTelegramIdentity"');
  expect(sql).toContain('"CustomerTelegramSession_identityId_key"');
  expect(sql).toContain('"CustomerTelegramSession_expiresAt_idx"');
  expect(sql).toContain('REFERENCES "OrderChatMessage"("id") ON DELETE SET NULL');
});
