import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// Run on the gateway with its existing environment. Never change STAFF or the gateway transport allowlist.
export async function registerCommands(manifest, backup, mode = 'apply', fetcher = fetch) {
  const token = process.env.TELEGRAM_CUSTOMER_BOT_TOKEN;
  if (!token || token === process.env.TELEGRAM_STAFF_BOT_TOKEN) throw new Error('CUSTOMER_TOKEN_REQUIRED');
  const expected = ['start', 'catalog', 'cart', 'orders', 'quick', 'delivery', 'menu', 'help'];
  if (!['apply', 'restore', 'verify'].includes(mode) || !Array.isArray(manifest.commands) ||
      manifest.commands.length !== expected.length || manifest.commands.some((item, i) => item.command !== expected[i] ||
        typeof item.description !== 'string' || !item.description.length || item.description.length > 256) ||
      !Array.isArray(manifest.chatIds) || !manifest.chatIds.length || manifest.chatIds.length > 20 ||
      manifest.chatIds.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('INVALID_MANIFEST');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const request = async (method, input) => {
    let response;
    try {
      response = await fetcher('https://api.telegram.org/bot' + token + '/' + method, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), redirect: 'error', signal: AbortSignal.timeout(8000) });
      const body = await response.json();
      if (!response.ok || body.ok !== true) throw new Error();
      return body.result;
    } catch { throw new Error('COMMAND_REQUEST_UNCONFIRMED_NO_RETRY'); }
  };
  const scopes = manifest.chatIds.flatMap(chat_id => ['', 'ru'].map(language_code => ({ scope: { type: 'chat', chat_id }, language_code })));
  let previous;
  if (mode === 'restore') {
    previous = JSON.parse(await readFile(backup, 'utf8'));
    if (previous.tokenHash !== tokenHash || JSON.stringify(previous.scopes) !== JSON.stringify(scopes)) throw new Error('BACKUP_MISMATCH');
  } else if (mode === 'apply') {
    previous = { tokenHash, scopes, commands: [] };
    for (const scope of scopes) previous.commands.push(await request('getMyCommands', scope));
    await writeFile(backup, JSON.stringify(previous), { flag: 'wx', mode: 0o600 });
  }
  for (const [index, scope] of scopes.entries()) {
    const commands = mode === 'restore' ? previous.commands[index] : manifest.commands;
    if (mode !== 'verify') {
      if (mode === 'restore' && !commands.length) await request('deleteMyCommands', scope);
      else await request('setMyCommands', { ...scope, commands });
    }
    const actual = await request('getMyCommands', scope);
    if (mode !== 'restore' && JSON.stringify(actual) !== JSON.stringify(commands)) throw new Error('COMMAND_VERIFICATION_FAILED');
    if (mode === 'restore' && commands.length && JSON.stringify(actual) !== JSON.stringify(commands)) throw new Error('COMMAND_RESTORE_FAILED');
  }
  return { mode, chats: manifest.chatIds.length, commands: manifest.commands.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [manifest, backup, mode] = process.argv.slice(2);
    if (!manifest || !backup) throw new Error('MANIFEST_AND_BACKUP_REQUIRED');
    console.log(JSON.stringify(await registerCommands(JSON.parse(await readFile(manifest, 'utf8')), backup, mode)));
  } catch (error) {
    console.error(error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'COMMAND_CONFIGURATION_FAILED');
    process.exitCode = 1;
  }
}
