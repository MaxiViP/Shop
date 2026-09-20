// Run from the repository root after `pnpm --filter web build`:
// node apps/web/test/seo.smoke.mjs
// Uses local fixtures and production Nitro output; no browser or database.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const artifactDir = process.env.SEO_SMOKE_ARTIFACT_DIR || join(tmpdir(), 'shop-seo-smoke');

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

const snapshot = process.env.SEO_SMOKE_FIXTURE
  ? JSON.parse(await readFile(process.env.SEO_SMOKE_FIXTURE, 'utf8'))
  : {
    categories: [{ id: 1, name: 'Fruit', slug: 'seo-fruit' }],
    products: [{
      id: 1, name: 'SSR apples', slug: 'seo-fixture', description: null,
      price: 12345, priceQty: 1000, unit: 'GRAM', min: 500, step: 100, portionQty: 500,
      category: { name: 'Fruit', slug: 'seo-fruit' }, images: [],
    }],
  };
const product = snapshot.products[0];
const category = snapshot.categories.find(item => item.slug === product.category.slug);
assert.ok(category && product);
const api = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let body;
  if (url.pathname === '/api/auth/me') body = null;
  else if (url.pathname === '/api/categories') body = snapshot.categories;
  else if (url.pathname === '/api/products') {
    const items = url.searchParams.has('category')
      ? snapshot.products.filter(p => p.category.slug === url.searchParams.get('category'))
      : snapshot.products;
    const page = Number(url.searchParams.get('page') || 1);
    const limit = Number(url.searchParams.get('limit') || 24);
    body = { items: items.slice((page - 1) * limit, page * limit), total: items.length, page, limit, pages: Math.ceil(items.length / limit) };
  } else if (url.pathname === '/api/products/seo-unavailable') {
    res.statusCode = 503; body = { message: 'Simulated API outage' };
  } else if (url.pathname.startsWith('/api/products/')) {
    body = snapshot.products.find(p => p.slug === decodeURIComponent(url.pathname.slice('/api/products/'.length)));
    if (!body) { res.statusCode = 404; body = { message: 'Product not found' }; }
  } else { res.statusCode = 404; body = { message: 'Unknown fixture route' }; }
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
      console.log('[seo-smoke-request] ' + url);
      return Promise.reject(new Error('Icon network disabled by SSR smoke'));
    }
    if (/^https?:/.test(url) && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) {
      console.log('[seo-smoke-external] ' + url);
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
  await mkdir(artifactDir, { recursive: true });
  const site = 'https://korzinamarket.ru';
  const attr = (tag, name) => new RegExp('\\b' + name + '="([^"]*)"').exec(tag)?.[1];
  const meta = (html, name) => [...html.matchAll(/<meta\b[^>]*>/g)]
    .map(m => m[0]).find(tag => attr(tag, 'name') === name || attr(tag, 'property') === name);
  const results = [];
  for (const path of ['/', '/catalog', '/catalog/' + category.slug, '/product/' + product.slug, '/delivery']) {
    const body = await readResponse(path);
    const title = /<title>([\s\S]*?)<\/title>/.exec(body)?.[1];
    const description = attr(meta(body, 'description') || '', 'content');
    const robots = attr(meta(body, 'robots') || '', 'content');
    const canonical = [...body.matchAll(/<link\b[^>]*>/g)].map(m => m[0])
      .filter(tag => attr(tag, 'rel') === 'canonical').map(tag => attr(tag, 'href'));
    const h1 = [...body.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/g)];
    const blocks = [...body.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)]
      .map(m => JSON.parse(m[1]));
    assert.ok(title?.includes('KorzinaMarket'), path + ' title');
    assert.ok(description && !description.includes('???'), path + ' description');
    assert.deepEqual(canonical, [site + path], path + ' canonical');
    assert.equal(h1.length, 1, path + ' H1');
    assert.equal(robots, 'index, follow', path + ' robots');
    assert.ok(blocks.length, path + ' JSON-LD');
    const entities = blocks.flatMap(value => Array.isArray(value) ? value : value['@graph'] || [value]);
    if (path.startsWith('/product/')) {
      const schema = entities.find(item => item['@type'] === 'Product');
      assert.equal(schema.name, product.name);
      assert.equal(schema.offers.price, (product.price / 100).toFixed(2));
      assert.equal(schema.offers.priceCurrency, 'RUB');
      assert.equal(schema.offers.availability, undefined);
    }
    if (path !== '/') assert.ok(entities.some(item => item['@type'] === 'BreadcrumbList'), path + ' breadcrumbs');
    const name = path === '/' ? 'home' : path.replaceAll('/', '-').slice(1);
    await writeFile(join(artifactDir, name + '.html'), body);
    results.push({ path, title, description, canonical: canonical[0], robots, h1: h1.length, jsonld: entities.map(x => x['@type']) });
  }
  for (const path of ['/cart', '/orders', '/favorites', '/admin/login', '/catalog?sort=price_asc']) {
    const response = await fetch(base + path, { redirect: 'manual', signal: AbortSignal.timeout(20000) });
    const body = await response.text();
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, follow', path);
    assert.equal(attr(meta(body, 'robots') || '', 'content'), 'noindex, follow', path);
  }
  for (const [path, status] of [['/catalog/seo-missing', 404], ['/product/seo-missing', 404], ['/product/seo-unavailable', 503]]) {
    const response = await fetch(base + path, { redirect: 'manual', signal: AbortSignal.timeout(20000) });
    assert.equal(response.status, status, path);
    await response.text();
  }
  const sitemapResponse = await fetch(base + '/sitemap.xml', { signal: AbortSignal.timeout(20000) });
  const xml = await sitemapResponse.text();
  assert.equal(sitemapResponse.status, 200);
  assert.match(sitemapResponse.headers.get('content-type'), /application\/xml/);
  assert.ok(xml.includes(site + '/product/' + product.slug));
  assert.ok(xml.includes(site + '/catalog/' + category.slug));
  assert.equal([...xml.matchAll(/<loc>/g)].length, 3 + snapshot.categories.length + snapshot.products.length);
  assert.ok(!xml.includes('/cart'));
  await writeFile(join(artifactDir, 'sitemap.xml'), xml);
  const robots = await readResponse('/robots.txt');
  assert.ok(robots.includes('Sitemap: ' + site + '/sitemap.xml'));
  assert.ok(!/Disallow:\s*\/\s*$/m.test(robots));
  await writeFile(join(artifactDir, 'results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ result: 'PASS', pages: results, sitemapUrls: 3 + snapshot.categories.length + snapshot.products.length, artifacts: artifactDir }, null, 2));

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
