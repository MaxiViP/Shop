// Run from the repository root after `pnpm --filter web build`:
// node apps/web/test/icons.smoke.mjs
// Uses local fixtures and production Nitro output; no browser or database.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { readFile, readdir, mkdir, writeFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const artifactDir = process.env.ICON_SMOKE_ARTIFACT_DIR;

async function bounded(promise, label, ms = 30000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + ' timeout')), ms);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

const product = {
  id: 1, name: 'Тестовые яблоки', slug: 'icon-fixture', description: 'SSR fixture',
  price: 19900, priceQty: 1000, unit: 'GRAM', min: 500, step: 100, portionQty: 500,
  category: { id: 1, name: 'Фрукты', slug: 'fruit' }, images: [],
};
const api = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  const role = /icon-role=(USER|SELLER|ADMIN)/.exec(req.headers.cookie || '')?.[1];
  let body;
  if (path === '/api/auth/me') body = role ? { id: 1, phone: '+79990000000', name: 'Fixture', role, verifiedAt: '2026-09-17T00:00:00Z' } : null;
  else if (path === '/api/categories') body = [{ ...product.category, children: [] }];
  else if (path === '/api/products') body = { items: [product], total: 1, page: 1, limit: 20, pages: 1 };
  else if (path === '/api/products/icon-fixture') body = product;
  else { res.statusCode = 404; body = { message: 'Unknown fixture route' }; }
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
});

// Installed before Nitro imports fetch. Block icon requests and external fetches,
// including redirects, so missing bundles cannot silently use a remote fallback.
const preload = `
  import { Server } from 'node:http';
  // Nitro treats NITRO_PORT=0 as 3000. Ask the OS for a port at the actual bind,
  // avoiding a reserve/release race with another process.
  const listen = Server.prototype.listen;
  Server.prototype.listen = function (options, ...args) {
    return listen.call(this, { ...options, host: '127.0.0.1', port: 0 }, ...args);
  };
  // A lost parent pipe must not leave Nitro running after an interrupted job.
  process.stdin.resume();
  process.stdin.on('end', () => process.exit());
  const observe = fetcher => (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('_nuxt_icon') || url.includes('iconify.design')) {
      console.log('[icon-smoke-request] ' + url);
      return Promise.reject(new Error('Icon network disabled by SSR smoke'));
    }
    if (/^https?:/.test(url) && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) {
      console.log('[icon-smoke-external] ' + url);
      return Promise.reject(new Error('External network disabled by SSR smoke'));
    }
    return fetcher(input, { ...init, redirect: 'error', signal: AbortSignal.timeout(10000) });
  };
  globalThis.fetch = observe(globalThis.fetch);
  let nitroFetch;
  Object.defineProperty(globalThis, '$fetch', {
    configurable: true,
    get: () => nitroFetch,
    set: value => {
      if (value.native) value.native = observe(value.native);
      nitroFetch = value;
    },
  });
`;
let child;
let closed;
let logs = '';

try {
  const listening = once(api, 'listening');
  api.listen(0, '127.0.0.1');
  await bounded(listening, 'Fixture startup');
  child = spawn(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(preload), '.output/server/index.mjs'], {
    cwd: root,
    env: { ...process.env, NODE_ENV: 'production', NITRO_HOST: '127.0.0.1', NITRO_PORT: '0',
      NITRO_UNIX_SOCKET: '', NITRO_SSL_CERT: '', NITRO_SSL_KEY: '', NUXT_APP_BASE_URL: '/',
      NUXT_PUBLIC_API_BASE: 'http://127.0.0.1:' + api.address().port + '/api' },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  closed = new Promise(resolve => child.once('close', resolve));
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });

  const startup = new AbortController();
  let base;
  try {
    base = await bounded(new Promise((resolve, reject) => {
      const onData = () => {
        const match = /Listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(logs);
        if (match) resolve(match[1]);
      };
      const onError = error => reject(error);
      const onExit = code => reject(new Error('Nitro exited: ' + code + '\n' + logs));
      child.stdout.on('data', onData);
      child.once('error', onError);
      child.once('exit', onExit);
      startup.signal.addEventListener('abort', () => {
        child.stdout.off('data', onData);
        child.off('error', onError);
        child.off('exit', onExit);
      }, { once: true });
    }), 'Nitro startup');
  } finally {
    startup.abort();
  }

  const readResponse = async (path, headers = {}) => {
    const url = new URL(path, base);
    assert.equal(url.origin, base, 'Only the local production server may be fetched');
    const response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200, path);
    return response.text();
  };
  if (artifactDir) await mkdir(artifactDir, { recursive: true });
  const { init } = await import(pathToFileURL(join(root, '.nuxt/nuxt-icon-client-bundle.mjs')));
  const bundled = new Map();
  init((name, data) => bundled.set(name, data));
  const used = new Set();
  for (const file of await readdir(join(root, 'app'), { recursive: true })) {
    if (!/\.(vue|ts)$/.test(file)) continue;
    const source = await readFile(join(root, 'app', file), 'utf8');
    for (const match of source.matchAll(/\bi-lucide-([a-z0-9-]+)/g)) used.add('lucide:' + match[1]);
  }
  const missing = [...used].filter(name => !bundled.get(name)?.body).sort();
  const appConfig = await readFile(join(root, '.nuxt/app.config.mjs'), 'utf8');
  const uiIcons = new Set([...appConfig.matchAll(/"[^"]+": "i-lucide-([a-z0-9-]+)"/g)].map(match => 'lucide:' + match[1]));
  assert.ok(uiIcons.size > 0, 'Generated Nuxt UI icons missing');
  const missingUi = [...uiIcons].filter(name => !bundled.get(name)?.body).sort();
  const measurements = { applicationIcons: used.size, uiIcons: uiIcons.size, bundleIcons: bundled.size,
    bundled: [...bundled.keys()], missing, missingUi, routes: [] };
  const uiRequire = createRequire(await realpath(join(root, 'node_modules/@nuxt/ui/package.json')));
  const iconRequire = createRequire(uiRequire.resolve('@nuxt/icon'));
  const iconify = await import(pathToFileURL(iconRequire.resolve('@iconify/vue')));
  for (const [name, data] of bundled) iconify.addIcon(name, data);
  const clientRequests = [];
  iconify._api.setFetch(url => {
    clientRequests.push(String(url));
    // Never send a request, even if Iconify tries an external fallback.
    return Promise.resolve(new Response(null, { status: 404 }));
  });
  iconify.addAPIProvider('', { resources: ['http://127.0.0.1:' + api.address().port + '/api/_nuxt_icon'] });
  const names = [...new Set([...used, ...uiIcons])].sort();
  const loaded = await bounded(Promise.allSettled(names.map(name => iconify.loadIcon(name))), 'Iconify loader');
  measurements.clientLoaderRequests = clientRequests;
  measurements.clientLoaderFailures = names.filter((_, index) => loaded[index].status === 'rejected');
  const output = join(root, '.output/public');
  measurements.cssBytes = 0;
  measurements.jsBytes = 0;
  for (const file of await readdir(output, { recursive: true })) {
    if (/\.(css|js)$/.test(file)) {
      const bytes = (await readFile(join(output, file))).length;
      if (file.endsWith('.css')) measurements.cssBytes += bytes;
      else measurements.jsBytes += bytes;
    }
  }
  for (const [index, route] of ['/', '/catalog', '/product/icon-fixture', '/'].entries()) {
    const admin = index === 3;
    const html = await readResponse(route, admin ? { Cookie: 'icon-role=ADMIN' } : {});
    const markup = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    let styles = [...markup.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n');
    for (const match of markup.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/g)) {
      const href = /href="([^"]+)"/.exec(match[0])?.[1];
      if (href) styles += await readResponse(href);
    }
    const cssIcons = [...markup.matchAll(/<span\b[^>]*class="[^"]*\bi-lucide:([a-z0-9-]+)[^"]*"[^>]*><\/span>/g)];
    const missingCss = cssIcons.filter(m => {
      const selector = '.i-lucide\\:' + m[1];
      const index = styles.indexOf(selector);
      const rule = index < 0 ? '' : styles.slice(index).match(/^[^{]*\{([^}]*)\}/)?.[1] || '';
      return !rule.includes('data:image/svg+xml') || !rule.includes('mask');
    }).map(m => m[1]);
    const svgs = [...markup.matchAll(/<svg\b[^>]*class="[^"]*(?:iconify|favorite__icon)[^"]*"[^>]*>([\s\S]*?)<\/svg>/g)];
    const emptySvg = svgs.filter(m => !/<(?:path|g|circle|rect|polygon|line)\b/.test(m[1])).length;
    measurements.routes.push({ route, admin, htmlBytes: Buffer.byteLength(html),
      cssIcons: cssIcons.map(m => m[1]), missingCss, svgIcons: svgs.length, emptySvg });
    if (artifactDir) {
      await writeFile(resolve(artifactDir, index + '.html'), html);
      await writeFile(resolve(artifactDir, index + '.css'), styles);
    }
    assert.deepEqual(missingCss, [], 'Missing first-response CSS: ' + route);
    assert.equal(emptySvg, 0, 'Empty SSR SVG: ' + route);
    assert.ok(svgs.length > 0, 'Product favorite SVG missing: ' + route);
    for (const icon of ['menu', 'user', 'heart', 'shopping-bag', admin ? 'clipboard-list' : 'package'])
      assert.ok(cssIcons.some(m => m[1] === icon), route + ': missing ' + icon);
    if (admin) assert.ok(cssIcons.some(m => m[1] === 'settings'));
    assert.ok(cssIcons.some(m => m[1] === 'plus'), route + ': missing plus');
  }
  measurements.iconRequests = logs.split('\n').filter(line => line.includes('[icon-smoke-request]'));
  measurements.externalRequests = logs.split('\n').filter(line => line.includes('[icon-smoke-external]'));
  measurements.iconWarnings = logs.split('\n').filter(line => /\[Icon\]|Failed to load custom icons/.test(line));
  console.log(JSON.stringify(measurements, null, 2));
  if (artifactDir) {
    await writeFile(resolve(artifactDir, 'metrics.json'), JSON.stringify(measurements, null, 2));
    await writeFile(resolve(artifactDir, 'server.log'), logs);
  }
  assert.deepEqual(missing, [], 'Application icons missing from the client bundle');
  assert.deepEqual(missingUi, [], 'Nuxt UI icons missing from the client bundle');
  assert.deepEqual(clientRequests, [], 'Iconify client loader attempted runtime fetch');
  assert.deepEqual(measurements.clientLoaderFailures, [], 'Iconify client loader failed');
  assert.deepEqual(measurements.iconRequests, [], 'SSR attempted runtime icon fetch');
  assert.deepEqual(measurements.externalRequests, [], 'SSR attempted external fetch');
  assert.deepEqual(measurements.iconWarnings, [], 'SSR icon warnings');
} finally {
  try {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      child.kill();
      try {
        await bounded(closed, 'Nitro shutdown', 5000);
      } catch {
        child.kill('SIGKILL');
        await bounded(closed, 'Nitro forced shutdown', 5000);
      }
    }
  } finally {
    child?.stdin.destroy();
    child?.stdout.destroy();
    child?.stderr.destroy();
    child?.unref();
    api.closeAllConnections();
    await bounded(new Promise(resolve => api.close(resolve)), 'Fixture shutdown', 5000);
  }
}
