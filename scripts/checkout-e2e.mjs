import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, symlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startWeb } from '../apps/web/test/browser.mjs';

const root = resolve(import.meta.dirname, '..');
const artifacts = resolve(root, 'work/checkout/artifacts');
await mkdir(artifacts, { recursive: true });
const log = createWriteStream(resolve(artifacts, 'runner.log'));
// Do not pass inherited database/notification/provider credentials to the test server.
const environment = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'SYSTEMROOT', 'HTTP_PROXY',
  'HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'COREPACK_HOME',
  'PNPM_HOME', 'CI'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
Object.assign(environment, { NODE_ENV: 'test', DOTENV_CONFIG_PATH: '/dev/null',
  AUTH_SECRET: randomBytes(32).toString('hex'), OTP_DELIVERY_MODE: 'DEV',
  ORDER_SMS_ENABLED: 'false', TEST_PHONE_AUTH_ENABLED: 'false' });

const dockerArgs = ['--host=unix:///var/run/docker.sock'];
const dockerEnv = { ...process.env };
for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) delete dockerEnv[key];
async function run(command, args, options = {}) {
  const child = spawn(command, args, { cwd: root, env: environment, ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => process.stderr.write(chunk));
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, command + ' failed; see work/checkout/artifacts/runner.log');
  return output.trim();
}

let container, server, web;
async function cleanup() {
  if (web) log.write(web.log);
  await web?.close();
  if (server?.exitCode === null) {
    const ended = once(server, 'exit');
    server.kill('SIGTERM');
    const timer = setTimeout(() => server.kill('SIGKILL'), 10000);
    await ended;
    clearTimeout(timer);
  }
  if (container) {
    const logs = spawn('docker', [...dockerArgs, 'logs', container], { env: dockerEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    logs.stdout.pipe(log, { end: false }); logs.stderr.pipe(log, { end: false });
    await once(logs, 'exit');
    await run('docker', [...dockerArgs, 'rm', '-f', container], { env: dockerEnv });
  }
}
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  interrupted = true;
  void cleanup().finally(() => process.exit(1));
});
try {
  let databaseUrl = process.env.E2E_DATABASE_URL;
  if (!databaseUrl) {
    container = 'checkout-e2e-' + randomUUID();
    const password = randomBytes(24).toString('hex');
    await run('docker', [...dockerArgs, 'run', '-d', '--name', container,
      '--label', 'korzinamarket.checkout-e2e=true',
      '--tmpfs', '/var/lib/postgresql:rw', '-p', '127.0.0.1::5432',
      '-e', 'POSTGRES_DB=checkout_e2e', '-e', 'POSTGRES_USER=checkout_e2e',
      '-e', 'POSTGRES_PASSWORD=' + password, 'postgres:18.6-bookworm'], { env: dockerEnv });
    const port = await run('docker', [...dockerArgs, 'port', container, '5432/tcp'], { env: dockerEnv });
    assert.match(port, /^127\.0\.0\.1:\d+$/);
    databaseUrl = `postgresql://checkout_e2e:${password}@${port}/checkout_e2e`;
    let ready = false;
    for (let attempt = 0; attempt < 60 && !ready; attempt++) {
      const check = spawn('docker', [...dockerArgs, 'exec', container, 'pg_isready', '-U', 'checkout_e2e'],
        { env: dockerEnv, stdio: 'ignore' });
      ready = (await once(check, 'exit'))[0] === 0;
      if (!ready) await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.ok(ready, 'Isolated PostgreSQL startup timed out');
  }
  const target = new URL(databaseUrl);
  assert.equal(target.protocol, 'postgresql:');
  assert.equal(target.hostname, '127.0.0.1');
  assert.equal(target.pathname, '/checkout_e2e');
  assert.equal(target.search, '');
  environment.E2E_DATABASE_URL = databaseUrl;
  environment.DATABASE_URL = databaseUrl;
  await run('pnpm', ['--filter', 'api', 'exec', 'prisma', 'generate', '--config', 'prisma7.config.ts']);
  await run('pnpm', ['--filter', 'api', 'exec', 'tsc', '-p', 'tsconfig.checkout.json']);
  await mkdir(resolve(root, 'work/checkout/api'), { recursive: true });
  try { await symlink(resolve(root, 'apps/api/node_modules'), resolve(root, 'work/checkout/api/node_modules'), 'dir'); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  // Emitted ESM must stay ESM even though the root package has no type field.
  const { writeFile } = await import('node:fs/promises');
  await writeFile(resolve(root, 'work/checkout/api/package.json'), '{"type":"module"}\n');
  await run('pnpm', ['--filter', 'web', 'build']);
  server = spawn(process.execPath, ['--import', resolve(root, 'scripts/checkout-network.mjs'),
    resolve(root, 'work/checkout/api/test/checkout/server.js')],
  { cwd: resolve(root, 'apps/api'), env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.pipe(log, { end: false }); server.stderr.pipe(log, { end: false });
  const ready = await new Promise((resolveReady, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Test API startup timeout; see runner.log')), 60000);
    server.once('error', reject);
    server.once('exit', code => { clearTimeout(timer); reject(new Error('Test API exited: ' + code + '; see runner.log')); });
    server.stdout.on('data', chunk => {
      output += chunk;
      const match = /__CHECKOUT_READY__(\{[^\n]+\})/.exec(output);
      if (match) { clearTimeout(timer); resolveReady(JSON.parse(match[1])); }
    });
  });
  // Reuse the existing local-only Nuxt smoke launcher, including its outbound fetch guard.
  web = await startWeb(ready.apiBase, environment);
  console.log('Checkout E2E: isolated PostgreSQL + real NestJS + built Nuxt, 390/1280 px');
  await run('pnpm', ['--filter', 'web', 'exec', 'playwright', 'test', '--config', 'playwright.checkout.config.ts', ...process.argv.slice(2)], {
    env: { ...environment, E2E_API_BASE: ready.apiBase, E2E_WEB_BASE: web.base,
      E2E_CONTROL_TOKEN: ready.token, ...(process.env.CATALOG_BROWSER_PATH ? { CATALOG_BROWSER_PATH: process.env.CATALOG_BROWSER_PATH } : {}) },
  });
  console.log('Checkout E2E passed; report: work/checkout/report/index.html');
} catch (error) {
  process.exitCode = 1;
  console.error(error);
} finally {
  if (!interrupted) await cleanup();
  log.end();
}
