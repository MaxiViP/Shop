import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerCommands } from './telegram-customer-commands.mjs';

const original = { customer: process.env.TELEGRAM_CUSTOMER_BOT_TOKEN, staff: process.env.TELEGRAM_STAFF_BOT_TOKEN };
const directories = [];
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
  for (const [name, value] of [['TELEGRAM_CUSTOMER_BOT_TOKEN', original.customer], ['TELEGRAM_STAFF_BOT_TOKEN', original.staff]])
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
});
async function fixture() {
  process.env.TELEGRAM_CUSTOMER_BOT_TOKEN = 'customer-fixture'; process.env.TELEGRAM_STAFF_BOT_TOKEN = 'staff-fixture';
  const dir = await mkdtemp(join(tmpdir(), 'customer-commands-')); directories.push(dir);
  const manifest = { chatIds: [123], commands: ['start', 'catalog', 'cart', 'orders', 'quick', 'delivery', 'menu', 'help']
    .map(command => ({ command, description: command })) };
  const calls = [], saved = new Map();
  const fetcher = async (url, init) => {
    const input = JSON.parse(init.body), method = url.split('/').at(-1), key = JSON.stringify([input.scope, input.language_code]);
    calls.push({ url, method, input });
    if (method === 'setMyCommands') saved.set(key, input.commands);
    if (method === 'deleteMyCommands') saved.delete(key);
    return Response.json({ ok: true, result: method === 'getMyCommands' ? saved.get(key) ?? [] : true });
  };
  return { manifest, backup: join(dir, 'before.json'), calls, fetcher };
}
test('backs up and registers only CUSTOMER chat scopes, verifies and restores them', async () => {
  const f = await fixture();
  assert.deepEqual(await registerCommands(f.manifest, f.backup, 'apply', f.fetcher), { mode: 'apply', chats: 1, commands: 8 });
  assert.equal(f.calls.every(call => call.url.includes('/botcustomer-fixture/')), true);
  assert.deepEqual(f.calls.filter(call => call.method === 'setMyCommands').map(call => call.input.scope), [{ type: 'chat', chat_id: 123 }, { type: 'chat', chat_id: 123 }]);
  assert.equal((await readFile(f.backup, 'utf8')).includes('customer-fixture'), false);
  await registerCommands(f.manifest, f.backup, 'verify', f.fetcher);
  await registerCommands(f.manifest, f.backup, 'restore', f.fetcher);
  assert.equal(f.calls.filter(call => call.method === 'deleteMyCommands').length, 2);
});
test('does not retry an unknown command mutation', async () => {
  const f = await fixture();
  let mutations = 0;
  await assert.rejects(registerCommands(f.manifest, f.backup, 'apply', async (url, init) => {
    if (url.endsWith('/setMyCommands')) { mutations++; throw new Error('secret provider URL'); }
    return f.fetcher(url, init);
  }), /COMMAND_REQUEST_UNCONFIRMED_NO_RETRY/);
  assert.equal(mutations, 1);
});
test('rejects ambiguous credentials and changed scopes before sending', async () => {
  const f = await fixture();
  process.env.TELEGRAM_CUSTOMER_BOT_TOKEN = 'staff-fixture';
  await assert.rejects(registerCommands(f.manifest, f.backup, 'apply', f.fetcher), /CUSTOMER_TOKEN_REQUIRED/);
  assert.equal(f.calls.length, 0);
});
