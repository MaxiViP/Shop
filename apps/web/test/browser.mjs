import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

export async function startWeb(apiBase) {
  assert.equal(new URL(apiBase).hostname, '127.0.0.1');
  const preload = `import { Server } from 'node:http';const listen=Server.prototype.listen;
    Server.prototype.listen=function(options,...args){return listen.call(this,{...options,host:'127.0.0.1',port:0},...args)};
    process.stdin.resume();process.stdin.on('end',()=>process.exit());
    const realFetch=fetch;globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'?input:input.url);
    if(!['127.0.0.1','localhost'].includes(url.hostname))throw new Error('External fetch disabled by smoke');return realFetch(input,init)};`;
  const child = spawn(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(preload), '.output/server/index.mjs'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NUXT_PUBLIC_API_BASE: apiBase, NITRO_HOST: '127.0.0.1', NITRO_PORT: '0' },
  });
  let log = '', base;
  child.stdout.on('data', chunk => { log += chunk; base = /Listening on (http:\/\/[^\s]+)/.exec(log)?.[1]; });
  child.stderr.on('data', chunk => { log += chunk; });
  for (let attempt = 0; attempt < 150 && !base; attempt++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(base, 'Nitro startup: ' + log.slice(-1000));
  return { base, async close() { if (child.exitCode === null) { const closed = once(child, 'exit'); child.stdin.end(); await closed; } } };
}

// Shared local Chromium test connection. Never attaches to the user's browser/profile.
export async function openBrowser(profile) {
  const path = process.env.CATALOG_BROWSER_PATH ?? (process.platform === 'win32' ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : null);
  assert.ok(path, 'Set CATALOG_BROWSER_PATH for a Chromium executable');
  const child = spawn(path, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--force-device-scale-factor=1',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'],
  { windowsHide: true, stdio: 'ignore' });
  let port;
  for (let attempt = 0; attempt < 200 && !port; attempt++) {
    try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n'); }
    catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.ok(port, 'Headless browser startup');
  const socket = new WebSocket('ws://127.0.0.1:' + port[0] + port[1]);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  const pending = new Map();
  let sequence = 0;
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data)), request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id); clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error))); else request.resolve(message.result);
  });
  const command = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timeout')); }, 15000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  return { command, async close() {
    await command('Browser.close').catch(() => {}); socket.close();
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Browser closed')); }
    if (child.exitCode === null) child.kill();
  } };
}
