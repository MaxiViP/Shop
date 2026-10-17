// Short, opt-in smoke of the production build. Local mock API + temp images only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { startWeb } from './browser.mjs';
import { express, imageVariantHandler, productImageFixture } from './fixtures/product-images.mjs';

const artifacts = fileURLToPath(new URL('../../../work/product-image-frontend/', import.meta.url));
await mkdir(artifacts, { recursive: true });
const fixture = await productImageFixture();
const products = Array.from({ length: 168 }, (_, index) => ({
  id: index + 1, slug: 'fixture-' + (index + 1), name: 'Тестовый товар ' + (index + 1),
  price: 11000, priceStatus: 'SOURCE', priceQty: 1, unit: 'PIECE', step: 1, min: 1, portionQty: 1,
  isSeasonal: false, isHit: false, seasonalStartsAt: null, seasonalEndsAt: null,
  marketPoint: null, category: { slug: 'fixture', name: 'Тестовые продукты' },
  images: [fixture.images[index % fixture.images.length]],
}));
const api = express();
api.use((req, res, next) => {
  if (req.headers.origin && new URL(req.headers.origin).hostname === '127.0.0.1') {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  next();
});
api.use(imageVariantHandler(fixture.registry));
api.use('/uploads/products', express.static(fixture.sourceRoot));
api.use('/api', (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1'), path = url.pathname;
  if (path === '/auth/me') return res.json(null);
  if (path === '/home/slides') return res.json({ slides: [], serverNow: new Date().toISOString(), validUntil: new Date(Date.now() + 60_000).toISOString() });
  if (path === '/categories') return res.json([{ id: 1, slug: 'fixture', name: 'Тестовые продукты' }]);
  if (path === '/shop/settings' || path === '/settings') return res.json({ deliveryEnabled: true, pickupEnabled: true });
  if (path === '/products') {
    const ids = url.searchParams.get('ids')?.split(',').map(Number);
    const list = ids ? products.filter(item => ids.includes(item.id)) : products;
    const offset = Number(url.searchParams.get('cursor') ?? 0), limit = Number(url.searchParams.get('limit') ?? 24);
    return res.json({ items: list.slice(offset, offset + limit), total: list.length, page: 1,
      limit, pages: Math.ceil(list.length / limit), nextCursor: offset + limit < list.length ? String(offset + limit) : null });
  }
  const product = products.find(item => path === '/products/' + item.slug);
  if (product) return res.json({ ...product, images: fixture.images, description: 'Локальная проверка фотографий' });
  return res.status(404).json({ message: 'Fixture route not found' });
});
const server = createServer(api);
const environment = Object.fromEntries(['PATH', 'SYSTEMROOT', 'TEMP', 'TMP', 'LOCALAPPDATA', 'NODE_EXTRA_CA_CERTS']
  .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
let web, legacy, browser;
const report = { status: 'failed', checks: [], matrix: [], gallery: [], fallback: [], hydrationErrors: [], external: [], scroll: null };
const fallbackOnly = process.argv.includes('--fallback-only');
const reportFile = artifacts + (fallbackOnly ? 'fallback-report.json' : 'report.json');
const passed = (name, details = {}) => report.checks.push({ name, ...details });
async function hydrated(page) {
  await page.waitForFunction(() =>
    document.querySelector('#__nuxt')?.__vue_app__?.$nuxt?.isHydrating === false);
}
async function newPage(base, width, dpr, height = 900, mobile = false,
  { failures = new Set(), delayHydration = false, delayedImages = new Map() } = {}) {
  const scripts = Promise.withResolvers();
  if (!delayHydration) scripts.resolve();
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr, isMobile: mobile, hasTouch: mobile });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== '127.0.0.1') { report.external.push(url.origin); return route.abort(); }
    if (url.pathname.startsWith('/_nuxt/') && url.pathname.endsWith('.js')) await scripts.promise;
    await delayedImages.get(url.pathname)?.promise;
    if (failures.has(url.pathname)) return route.fulfill({ status: 503, headers: { 'cache-control': 'no-store' }, body: '' });
    return route.continue();
  });
  await context.addInitScript(() => { localStorage.setItem('favorites', '[1,2,3]'); });
  const page = await context.newPage();
  page.on('console', message => { if (/hydration|mismatch|Vue warn/i.test(message.text())) report.hydrationErrors.push({ base, width, path: page.url(), text: message.text(), location: message.location() }); });
  page.on('pageerror', error => report.hydrationErrors.push(error.message));
  const visit = async (path, beforeHydration) => {
    const response = await page.goto(base + path, { waitUntil: delayHydration ? 'commit' : 'domcontentloaded' });
    assert.equal(response.status(), 200);
    if (beforeHydration) await beforeHydration(page);
    scripts.resolve();
    await hydrated(page);
    await page.evaluate(() => document.fonts.ready);
  };
  return { page, visit, async close() {
    scripts.resolve();
    for (const gate of delayedImages.values()) gate.resolve();
    await context.close();
  } };
}
async function loaded(page, selector = '.card__img img', expectedSrc) {
  try { await page.waitForFunction(({ selector, expectedSrc }) => {
    const images = [...document.querySelectorAll(selector)].filter(image => {
      if (selector !== '.card__img img') return true;
      const rect = image.getBoundingClientRect();
      return rect.top < innerHeight && rect.bottom > 0;
    });
    return images.length > 0 && images.every(image => image.complete && image.naturalWidth > 0 &&
      (!expectedSrc || image.getAttribute('src') === expectedSrc));
  }, { selector, expectedSrc }, { timeout: 8000 }); } catch (error) {
    console.error('Image state:', await page.locator(selector).first().evaluate(image => ({
      complete: image.complete, naturalWidth: image.naturalWidth, currentSrc: image.currentSrc,
      src: image.getAttribute('src'), srcset: image.getAttribute('srcset'),
    })).catch(() => 'No image'), 'Hydration:', report.hydrationErrors);
    throw error;
  }
}
async function beforeHydration(page, complete, selector = '.card__img img') {
  await page.waitForFunction(({ selector, complete }) => {
    const image = document.querySelector(selector);
    return image && image.complete === complete && image.naturalWidth === 0;
  }, { selector, complete });
  assert.equal(await page.evaluate(() => !!document.querySelector('#__nuxt')?.__vue_app__), false);
}
async function geometry(page, selector = '.card__img img') {
  return page.locator(selector).first().evaluate(image => {
    const rect = element => { const box = element.getBoundingClientRect(); return { width: box.width, height: box.height }; };
    // Compare the HTML sizes parser's density-corrected naturalWidth against
    // the same expression resolved by CSS, not against a guessed breakpoint.
    let expression;
    if (image.sizes) {
      let depth = 0, start = 0;
      const clauses = [];
      for (let index = 0; index <= image.sizes.length; index++) {
        const char = image.sizes[index];
        if (char === '(') depth++; if (char === ')') depth--;
        if (index === image.sizes.length || (char === ',' && depth === 0)) {
          clauses.push(image.sizes.slice(start, index).trim()); start = index + 1;
        }
      }
      for (const clause of clauses) {
        const at = clause.indexOf('calc('), media = clause.slice(0, at).trim();
        if ((!media || matchMedia(media).matches) && CSS.supports('width', clause.slice(at))) { expression = clause.slice(at); break; }
      }
    }
    let declared = null;
    if (expression) {
      const probe = document.createElement('div');
      probe.style.cssText = 'position:absolute;visibility:hidden;width:' + expression;
      document.body.append(probe); declared = probe.getBoundingClientRect().width; probe.remove();
    }
    const card = image.closest('.card');
    return { box: rect(image), card: card ? rect(card) : null, naturalWidth: image.naturalWidth,
      declared, src: image.getAttribute('src'), srcset: image.getAttribute('srcset'), sizes: image.getAttribute('sizes'),
      currentSrc: image.currentSrc, fit: getComputedStyle(image).objectFit,
      loading: image.getAttribute('loading'), decoding: image.getAttribute('decoding'),
      dpr: devicePixelRatio, columns: card ? getComputedStyle(card.parentElement).gridTemplateColumns.split(' ').length : null };
  });
}
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  web = await startWeb(base + '/api', { ...environment, NUXT_PUBLIC_PRODUCT_IMAGE_VARIANTS: 'true' });
  legacy = await startWeb(base + '/api', { ...environment, NUXT_PUBLIC_PRODUCT_IMAGE_VARIANTS: 'false' });
  browser = await chromium.launch({ executablePath: process.env.CATALOG_BROWSER_PATH ??
    (process.platform === 'win32' ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : undefined),
    headless: true, args: ['--disable-background-networking', '--disable-component-update', '--disable-sync'] });
  const ssr = await (await fetch(web.base + '/catalog')).text();
  assert.ok(ssr.includes('srcset=') && ssr.includes('sizes='));
  assert.equal((ssr.match(/fetchpriority="high"/g) ?? []).length, 4);
  assert.ok(ssr.includes('loading="lazy"'));
  assert.ok(!(await (await fetch(legacy.base + '/catalog')).text()).includes('srcset='));
  for (const [width, dpr, height, mobile] of [[390, 1, 844, true], [390, 2, 844, true], [390, 3, 844, true],
    [1440, 1, 900, false], [1440, 2, 900, false], [1440, 3, 900, false], [639, 3, 900, false], [844, 2, 390, true]].filter(() => !fallbackOnly)) {
    const view = await newPage(web.base, width, dpr, height, mobile);
    try {
      await view.visit('/catalog'); await loaded(view.page);
      const result = await geometry(view.page);
      assert.equal(result.src, base + fixture.images[0].url);
      assert.equal(result.fit, 'contain');
      assert.equal(result.loading, 'eager');
      assert.equal(result.decoding, 'auto');
      const priorities = await view.page.locator('.card__img img').evaluateAll(images =>
        images.map(image => image.getAttribute('fetchpriority')));
      assert.deepEqual(priorities.slice(0, 4), ['high', 'high', 'high', 'high']);
      assert.ok(priorities.slice(4).every(value => value === 'auto'));
      assert.ok(result.declared > 0 && Math.abs(result.naturalWidth - result.declared) < 2, 'sizes must be understood by the browser');
      const sources = await view.page.locator('.card__img img').evaluateAll(images => images.slice(0, 3).map(image => image.currentSrc));
      for (const [index, src] of sources.entries()) assert.ok(
        [fixture.images[index].url, ...fixture.images[index].variants.webp.map(image => image.url)].includes(new URL(src).pathname));
      assert.equal(sources[2], base + fixture.images[2].url, 'tiny images must keep the native original');
      report.matrix.push({ width, dpr, ...result });
      passed('responsive photographs', { width, dpr });
      if ((width === 390 || width === 1440) && dpr === 2) {
        await writeFile(artifacts + 'img-' + width + '.html', await view.page.locator('.card__img img').first().evaluate(image => image.outerHTML));
        await view.page.screenshot({ path: artifacts + 'catalog-' + width + '-dpr2.png' });
        const old = await newPage(legacy.base, width, dpr, height, mobile);
        try {
          await old.visit('/catalog'); await loaded(old.page);
          const before = await geometry(old.page);
          assert.equal(before.srcset, null); assert.equal(before.sizes, null); assert.equal(before.decoding, 'auto');
          assert.deepEqual(before.card, result.card); assert.deepEqual(before.box, result.box);
          passed('feature flag off preserves geometry and original attributes', { width });
        } finally { await old.close(); }
      }
      if (width === 1440 && dpr === 2) {
        for (let attempt = 0; attempt < 10; attempt++) {
          if (Number(await view.page.locator('.catalog').getAttribute('data-loaded-count')) >= 144) break;
          await view.page.evaluate(() => scrollTo(0, document.body.scrollHeight)); await view.page.waitForTimeout(200);
        }
        await view.page.waitForFunction(() => Number(document.querySelector('.catalog')?.getAttribute('data-loaded-count')) >= 144);
        for (const top of [1000, 6000, 2000, 0]) { await view.page.evaluate(top => scrollTo(0, top), top); await view.page.waitForTimeout(100); }
        report.scroll = await view.page.locator('.grid[data-windowed]').first().evaluate(grid => ({
          rendered: grid.querySelectorAll('.card').length, indices: [...grid.querySelectorAll('[data-product-index]')].map(card => Number(card.dataset.productIndex)),
        }));
        assert.ok(report.scroll.rendered < 144);
        assert.equal(new Set(report.scroll.indices).size, report.scroll.indices.length);
        await loaded(view.page);
        passed('windowed catalog scroll preserves loaded photographs');
      }
    } finally { await view.close(); }
  }
  if (!fallbackOnly) {
    const compact = await newPage(web.base, 390, 2, 844, true);
    try {
      await compact.visit('/favorites'); await loaded(compact.page);
      const result = await geometry(compact.page);
      assert.ok(Math.abs(result.box.width / result.box.height - 4 / 3) < .01);
      report.matrix.push({ page: 'favorites', width: 390, ...result });
      passed('compact favorites photographs');
      await compact.visit('/'); await loaded(compact.page);
      assert.ok((await geometry(compact.page)).srcset);
      await compact.page.locator('.card__add').first().click();
      await compact.page.locator('.card--added').first().waitFor();
      passed('home photographs and add to cart');
    } finally { await compact.close(); }
  }
  for (const width of [390, 1440]) for (const timing of ['failed-before-hydration', 'pending-at-hydration']) for (const originalFails of [false, true]) {
    const failures = new Set(fixture.images[0].variants.webp.map(image => image.url));
    if (originalFails) failures.add(fixture.images[0].url);
    const gate = Promise.withResolvers();
    const delayedImages = timing === 'pending-at-hydration'
      ? new Map(fixture.images[0].variants.webp.map(image => [image.url, gate])) : new Map();
    const view = await newPage(web.base, width, 2, 844, width === 390, { failures, delayedImages, delayHydration: true });
    const requests = [];
    view.page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/uploads/products/')) requests.push(request.url()); });
    try {
      await view.visit('/catalog', page => beforeHydration(page, timing === 'failed-before-hydration'));
      if (timing === 'pending-at-hydration') {
        assert.equal(await view.page.locator('.card__img img').first().evaluate(image => image.complete), false);
        assert.equal(await view.page.locator('.card__img').first().getByText('Фото скоро').count(), 0);
        gate.resolve();
      }
      if (originalFails) {
        await view.page.locator('.card__img').first().getByText('Фото скоро').waitFor();
        assert.equal(await view.page.locator('.card__img').first().locator('img').count(), 0);
      } else {
        await loaded(view.page);
        const result = await geometry(view.page);
        assert.equal(result.currentSrc, base + fixture.images[0].url);
        assert.equal(result.srcset, null); assert.equal(result.sizes, null);
      }
      await view.page.waitForTimeout(200);
      const count = requests.length;
      await view.page.waitForTimeout(300); assert.equal(requests.length, count, 'error fallback must settle');
      report.fallback.push({ width, timing, originalFails, settledRequests: count });
      passed('variant failure settles at original or placeholder', { width, timing, originalFails });
      if (originalFails && timing === 'failed-before-hydration') {
        await view.visit('/product/fixture-1');
        await view.page.locator('.gallery__viewport .gallery__empty').waitFor();
        await view.page.locator('.gallery__thumb').nth(1).click(); await loaded(view.page, '.gallery__image', base + fixture.images[1].url);
        assert.equal((await geometry(view.page, '.gallery__image')).currentSrc, base + fixture.images[1].url);
        failures.clear();
        await view.page.locator('.gallery__thumb').nth(0).click(); await loaded(view.page, '.gallery__image', base + fixture.images[0].url);
        assert.equal((await geometry(view.page, '.gallery__image')).srcset, null);
        passed('gallery selection recovers from failed original and returns to it', { width });
      }
    } finally { await view.close(); }
  }
  for (const width of [390, 1440]) {
    const gate = Promise.withResolvers();
    const delayedImages = new Map(fixture.images[0].variants.webp.map(image => [image.url, gate]));
    const view = await newPage(web.base, width, 2, 844, width === 390, { delayedImages, delayHydration: true });
    try {
      await view.visit('/catalog', page => beforeHydration(page, false));
      assert.equal(await view.page.locator('.card__img img').first().evaluate(image => image.complete), false);
      gate.resolve(); await loaded(view.page);
      assert.ok((await geometry(view.page)).srcset, 'a pending successful image must retain its candidates');
      passed('pending image completes after hydration without fallback', { width });
    } finally { await view.close(); }

    const failures = new Set([fixture.images[0].url]);
    const old = await newPage(legacy.base, width, 2, 844, width === 390, { failures, delayHydration: true });
    let requests = 0;
    old.page.on('request', request => { if (new URL(request.url()).pathname === fixture.images[0].url) requests++; });
    try {
      await old.visit('/catalog', page => beforeHydration(page, true));
      await old.page.locator('.card__img').first().getByText('Фото скоро').waitFor();
      await loaded(old.page);
      const count = requests;
      await old.page.waitForTimeout(400); assert.equal(requests, count);
      passed('feature flag off handles a pre-hydration original failure without retries', { width, requests });
    } finally { await old.close(); }

    const previousRequest = Promise.withResolvers();
    const gallery = await newPage(web.base, width, 2, 844, width === 390, {
      failures, delayedImages: new Map([[fixture.images[0].url, previousRequest]]),
    });
    try {
      await gallery.visit('/product/fixture-1');
      const previousImage = await gallery.page.locator('.gallery__image').elementHandle();
      assert.equal(await previousImage.evaluate(image => image.complete), false);
      await gallery.page.locator('.gallery__thumb').nth(1).click();
      await loaded(gallery.page, '.gallery__image', base + fixture.images[1].url);
      previousRequest.resolve();
      await previousImage.dispatchEvent('error');
      await gallery.page.waitForTimeout(200);
      assert.equal((await geometry(gallery.page, '.gallery__image')).currentSrc, base + fixture.images[1].url);
      assert.equal(await gallery.page.locator('.gallery__viewport .gallery__empty').count(), 0);
      passed('late error from the previous gallery photo cannot reject the selected photo', { width });
    } finally { await gallery.close(); }
  }
  for (const width of fallbackOnly ? [] : [390, 1440]) {
    const view = await newPage(web.base, width, 2, 900, width === 390);
    try {
      await view.visit('/product/fixture-1'); await loaded(view.page, '.gallery__image');
      const result = await geometry(view.page, '.gallery__image');
      assert.equal(result.srcset, null);
      assert.ok(await view.page.locator('.gallery__thumb img').first().getAttribute('srcset'));
      await loaded(view.page, '.gallery__thumb img');
      for (const index of [1, 2, 0]) {
        await view.page.locator('.gallery__thumb').nth(index).click();
        await loaded(view.page, '.gallery__image', base + fixture.images[index].url);
        const selected = await geometry(view.page, '.gallery__image');
        assert.equal(selected.currentSrc, base + fixture.images[index].url);
        assert.equal(selected.srcset, null);
      }
      report.gallery.push({ width, ...result });
      passed('gallery originals, responsive thumbnails and selected photo changes', { width });
    } finally { await view.close(); }
  }
  assert.deepEqual(report.hydrationErrors, []);
  assert.deepEqual(report.external, []);
  report.status = 'passed';
  console.log(JSON.stringify({ status: report.status, passed: report.checks.length, matrix: report.matrix.map(({ width, dpr, page, currentSrc, box, columns, declared }) =>
    ({ width, dpr, page, file: new URL(currentSrc).pathname.split('/').pop(), box, columns, declared })),
    gallery: report.gallery.map(({ width, box }) => ({ width, box })), scroll: report.scroll,
    fallback: report.fallback, hydrationErrors: report.hydrationErrors.length, externalRequests: report.external.length }, null, 2));
} finally {
  await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
  await browser?.close();
  await web?.close(); await legacy?.close();
  await new Promise(resolve => server.close(resolve));
  await fixture.close();
}
