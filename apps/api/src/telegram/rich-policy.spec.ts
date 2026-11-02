import { mkdtemp, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { richEnabled, galleryTablesEnabled } from './rich-policy.js';

let directory: string, config: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'rich-global-')); config = join(directory, 'policy.json');
  vi.stubEnv('TELEGRAM_RICH_CONFIG_FILE', config);
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });
const save = async (value: unknown) => { await writeFile(config + '.next', JSON.stringify(value)); await rename(config + '.next', config); };

it('keeps table galleries opt-in even with global Rich and hot reloads their independent off switch', async () => {
  await save({ enabled: true, global: { customer: true, staff: true } });
  expect(await galleryTablesEnabled(123)).toBe(false);
  await save({ enabled: true, global: { customer: true, staff: true }, customerGalleryTables: ['123'] });
  expect(await galleryTablesEnabled(123)).toBe(true); expect(await galleryTablesEnabled(124)).toBe(false);
  expect(await richEnabled('customer', 124)).toBe(true); expect(await richEnabled('staff', 124)).toBe(true);
  await save({ enabled: true, global: { customer: true, staff: true }, customerGalleryTables: [] });
  expect(await galleryTablesEnabled(123)).toBe(false); expect(await richEnabled('customer', 123)).toBe(true);
});
it('requires both CUSTOMER Rich access and an explicit table entry, and fails closed', async () => {
  for (const value of [{ enabled: false, global: { customer: true }, customerGalleryTables: ['123'] },
    { enabled: true, staff: ['123'], customerGalleryTables: ['123'] },
    { enabled: true, global: { customer: true }, customerGalleryTables: true },
    { enabled: true, global: { customer: true }, customerGalleryTables: ['bad'] }]) {
    await save(value); expect(await galleryTablesEnabled(123)).toBe(false);
  }
  await save({ enabled: true, customer: ['123'], customerGalleryTables: ['123'] });
  expect(await galleryTablesEnabled(123)).toBe(true); expect(await galleryTablesEnabled(0)).toBe(false);
});

it.each(['customer', 'staff'] as const)('enables %s globally without listing IDs, independently of the other bot', async bot => {
  await save({ enabled: true, global: { [bot]: true } });
  expect(await richEnabled(bot, 987654321)).toBe(true);
  expect(await richEnabled(bot === 'customer' ? 'staff' : 'customer', 987654321)).toBe(false);
});
it('preserves the existing per-bot allowlists when global mode is absent or disabled', async () => {
  for (const global of [undefined, { customer: false, staff: false }]) {
    await save({ enabled: true, customer: ['123'], staff: ['124'], global });
    expect(await richEnabled('customer', 123)).toBe(true); expect(await richEnabled('staff', 124)).toBe(true);
    expect(await richEnabled('customer', 124)).toBe(false); expect(await richEnabled('staff', 123)).toBe(false);
  }
});
it('hot reloads atomic global/off/allowlist transitions on the next screen without a restart', async () => {
  await save({ enabled: true, global: { customer: true, staff: true } });
  for (const bot of ['customer', 'staff'] as const) expect(await richEnabled(bot, 987654321)).toBe(true);
  await save({ enabled: false, global: { customer: true, staff: true }, customer: ['987654321'], staff: ['987654321'] });
  for (const bot of ['customer', 'staff'] as const) expect(await richEnabled(bot, 987654321)).toBe(false);
  await save({ enabled: false });
  expect(await richEnabled('customer', 987654321)).toBe(false);
  await save({ enabled: true, customer: ['123'], staff: ['124'] });
  expect(await richEnabled('customer', 987654321)).toBe(false); expect(await richEnabled('staff', 124)).toBe(true);
});
it.each([0, -100123, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])('keeps invalid/group chat %s disabled even globally', async chatId => {
  await save({ enabled: true, global: { customer: true, staff: true } });
  expect(await richEnabled('customer', chatId)).toBe(false); expect(await richEnabled('staff', chatId)).toBe(false);
});
it.each([
  { enabled: true, global: true }, { enabled: true, global: { customer: 'true' } },
  { enabled: true, global: { staff: 1 } }, { enabled: true, global: { all: true } },
  { enabled: true, all: true }, { global: { customer: true, staff: true } },
  { enabled: true, global: { customer: true }, staff: ['invalid'] },
])('fails closed for a malformed global policy %#', async value => {
  await save(value);
  expect(await richEnabled('customer', 123)).toBe(false); expect(await richEnabled('staff', 123)).toBe(false);
});
it('fails closed for missing, truncated, oversized or unconfigured policy files', async () => {
  expect(await richEnabled('customer', 123)).toBe(false);
  await writeFile(config, '{"enabled":true,"global":'); expect(await richEnabled('customer', 123)).toBe(false);
  await writeFile(config, JSON.stringify({ enabled: true, global: { customer: true } }) + ' '.repeat(32768));
  expect(await richEnabled('customer', 123)).toBe(false);
  await save({ enabled: true, global: { customer: true } }); vi.stubEnv('TELEGRAM_RICH_CONFIG_FILE', '');
  expect(await richEnabled('customer', 123)).toBe(false);
});
