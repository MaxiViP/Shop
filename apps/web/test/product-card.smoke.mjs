// Production-build smoke: loopback fixture API and isolated Chromium only.
// Run: node apps/web/test/product-card.smoke.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { startWeb } from './browser.mjs';

const artifacts = await mkdtemp(join(tmpdir(), 'korzina-product-card-'));
const category = { id: 1, slug: 'fixture', name: 'Тестовые продукты' };
const products = Array.from({ length: 24 }, (_, index) => ({
  id: index + 1, slug: `fixture-${index + 1}`, name: `Товар ${index + 1}`,
  price: 10000 + index * 100, priceStatus: 'SOURCE', priceQty: 1,
  unit: 'PIECE', step: 1, min: 1, portionQty: 1, isSeasonal: false, isHit: false,
  seasonalStartsAt: null, seasonalEndsAt: null, marketPoint: null, category,
  images: [{ url: '/images/hero/hero-0.webp', alt: 'Тестовое фото' }],
}));
Object.assign(products[1], { unit: 'GRAM', price: 19999, priceQty: 1000, step: 100, min: 500, portionQty: 500 });
Object.assign(products[23], { unit: 'PACK' });
let signedIn = false;
const api = createServer(async (request, response) => {
  response.setHeader('Content-Type', 'application/json');
  if (request.headers.origin) {
    assert.match(request.headers.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    response.setHeader('Access-Control-Allow-Origin', request.headers.origin);
    response.setHeader('Access-Control-Allow-Credentials', 'true');
    response.setHeader('Access-Control-Allow-Headers', 'content-type');
    response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  }
  if (request.method === 'OPTIONS') return response.end();
  const path = new URL(request.url, 'http://127.0.0.1').pathname;
  let body = [];
  if (path === '/api/auth/me') body = signedIn
    ? { id: 1, name: null, phone: '+79990000001', role: 'USER', verifiedAt: '2026-10-18T12:00:00Z', telegram: null }
    : null;
  else if (path === '/api/cart') body = { revision: '0', items: [], products: [], subtotal: 0, valid: true, error: null, token: 'fixture' };
  else if (path === '/api/favorites') body = { items: [] };
  else if (path.startsWith('/api/favorites/')) body = { ok: true };
  else if (path === '/api/orders/unread') body = { count: 0 };
  else if (path === '/api/order-phones') body = { primaryPhone: null, phones: [] };
  else if (path === '/api/home/slides') body = { slides: [], serverNow: '2026-10-18T12:00:00Z', validUntil: null };
  else if (path === '/api/categories') body = [category];
  else if (path === '/api/products') body = { items: products, total: 24, page: 1, pages: 1, limit: 24, nextCursor: null };
  else if (path.startsWith('/api/products/')) body = { ...products.find(product => path.endsWith(product.slug)), description: 'Тестовый товар' };
  else if (path === '/api/shop/settings') body = { deliveryEnabled: true, pickupEnabled: true, minDeliverySubtotal: 0 };
  else if (path === '/api/orders/quote') {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    const items = input.items.map(line => {
      const product = products.find(product => product.id === line.productId);
      return { ...line, product, status: 'AVAILABLE', lineTotal: Math.round(product.price * line.qty / product.priceQty) };
    });
    body = { items, subtotal: items.reduce((sum, line) => sum + line.lineTotal, 0), valid: true, error: null, token: 'fixture' };
  }
  response.end(JSON.stringify(body));
});

let web, browser;
const report = { checks: [], errors: [] };
try {
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  web = await startWeb(`http://127.0.0.1:${api.address().port}/api`);
  const html = await (await fetch(web.base)).text();
  const cards = html.match(/<article class="card[\s\S]*?<\/article>/g) ?? [];
  assert.equal(cards.length, 24);
  for (const [index, card] of cards.entries()) {
    assert.ok(card.includes(products[index].name));
    assert.ok(card.includes(`href="/product/${products[index].slug}"`));
    assert.match(card, /class="price"/);
    assert.match(card, /<button[^>]*class="[^"]*favorite/);
    assert.ok(card.includes('aria-pressed="false"'));
  }
  report.checks.push({ name: 'SSR includes all 24 cards, prices, links and favorite buttons' });
  browser = await chromium.launch({
    executablePath: process.env.CATALOG_BROWSER_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true,
  });
  for (const width of [390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, deviceScaleFactor: 2,
      isMobile: width < 600, hasTouch: width < 600 });
    await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('console', message => { if (/hydration|mismatch/i.test(message.text())) report.errors.push(message.text()); });
    const first = page.locator('[data-product-index="0"]');
    const last = page.locator('[data-product-index="23"]');
    await page.goto(web.base, { waitUntil: 'domcontentloaded' });
    // Auto-wait only for the actual enabled SSR button, with no extra hydration delay.
    await first.locator('.card__add').click();
    await first.locator('.card__portion').first().waitFor();
    await page.waitForFunction(() => document.querySelector('#__nuxt').__vue_app__.config.globalProperties.$nuxt.$pinia._s.get('cart').qty(1) === 1);
    await first.locator('.favorite').click();
    assert.equal(await first.locator('.favorite').getAttribute('aria-pressed'), 'true');
    report.checks.push({ width, name: 'first cart and favorite clicks handled once immediately after readiness' });

    // Deterministic scroll/click race; no visibility or hydration wait between them.
    const rapid = await last.evaluate(card => {
      card.scrollIntoView({ block: 'center' });
      card.querySelector('.favorite').click();
      card.querySelector('.card__add').click();
      const stores = document.querySelector('#__nuxt').__vue_app__.config.globalProperties.$nuxt.$pinia._s;
      return { favorite: stores.get('favorites').has(24), qty: stores.get('cart').qty(24) };
    });
    assert.deepEqual(rapid, { favorite: true, qty: 1 });
    await last.locator('.card__portion').last().click();
    await page.waitForFunction(() => document.querySelector('#__nuxt').__vue_app__.config.globalProperties.$nuxt.$pinia._s.get('cart').qty(24) === 2);
    report.checks.push({ width, name: 'scroll and immediate favorite/cart interaction; trusted quantity click' });

    const favorite = last.locator('.favorite');
    await favorite.focus();
    await page.keyboard.press('Space');
    assert.equal(await favorite.getAttribute('aria-pressed'), 'false');
    await page.keyboard.press('Enter');
    assert.equal(await favorite.getAttribute('aria-pressed'), 'true');
    report.checks.push({ width, name: 'keyboard Space/Enter and aria-pressed' });

    const weight = page.locator('[data-product-index="1"]');
    await weight.locator('.card__add').click();
    await weight.locator('.card__portion').last().click();
    await page.waitForFunction(() => {
      const cart = document.querySelector('#__nuxt').__vue_app__.config.globalProperties.$nuxt.$pinia._s.get('cart');
      return cart.qty(2) === 600 && cart.quoteReady;
    });
    assert.match(await weight.locator('.price').innerText(), /199,99\s*₽/);
    assert.match(await weight.locator('.price__unit').innerText(), /кг/);
    assert.match(await weight.locator('.card__quantity').innerText(), /600 г/);
    assert.match(await weight.locator('.card__quantity').getAttribute('title'), /119,99\s*₽/);
    report.checks.push({ width, name: 'server quote, kopecks, weight step and quantity display preserved' });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await first.locator('.card__portion').first().waitFor();
    await page.waitForFunction(() => {
      const stores = document.querySelector('#__nuxt').__vue_app__.config.globalProperties.$nuxt.$pinia._s;
      const cart = stores.get('cart');
      return cart.restored && cart.quoteReady && cart.qty(1) === 1 && cart.qty(2) === 600 && cart.qty(24) === 2 &&
        stores.get('favorites').has(1) && stores.get('favorites').has(24);
    });
    assert.match(await weight.locator('.card__quantity').innerText(), /600 г/);
    assert.equal(await first.locator('.favorite').getAttribute('aria-pressed'), 'true');
    await last.scrollIntoViewIfNeeded();
    assert.equal(await last.locator('.card__portion').last().isEnabled(), true);
    await last.locator('.favorite').click();
    assert.equal(await last.locator('.favorite').getAttribute('aria-pressed'), 'false');
    await last.locator('.card__img img').evaluate(image => image.decode());
    report.checks.push({ width, name: 'cart/favorites restored after reload; bottom controls and image ready' });
    await page.screenshot({ path: join(artifacts, `cards-${width}.png`) });
    await last.locator('.card__link').click();
    await page.waitForURL('**/product/fixture-24');
    const detailFavorite = page.locator('.product__head .favorite');
    await detailFavorite.click();
    assert.equal(await detailFavorite.getAttribute('aria-pressed'), 'true');
    report.checks.push({ width, name: 'product navigation and standalone favorite button' });
    await context.close();

    // Real pending lifecycle against the local fixture, with the response held.
    signedIn = true;
    const authenticated = await browser.newContext({ viewport: { width, height: 844 } });
    const gate = Promise.withResolvers();
    let mutations = 0;
    await authenticated.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    await authenticated.route('**/api/favorites/1', async route => {
      mutations++;
      await gate.promise;
      await route.continue();
    });
    try {
      const serverPage = await authenticated.newPage();
      serverPage.on('pageerror', error => report.errors.push(error.message));
      await serverPage.goto(web.base, { waitUntil: 'networkidle' });
      const serverFavorite = serverPage.locator('[data-product-index="0"] .favorite');
      const requestSeen = serverPage.waitForRequest(request => new URL(request.url()).pathname === '/api/favorites/1');
      await serverFavorite.click();
      await requestSeen;
      assert.equal(await serverFavorite.isDisabled(), true);
      await serverFavorite.evaluate(button => button.click());
      gate.resolve();
      await serverPage.waitForFunction(() => !document.querySelector('[data-product-index="0"] .favorite').disabled);
      assert.equal(mutations, 1);
      assert.equal(await serverFavorite.getAttribute('aria-pressed'), 'true');
      report.checks.push({ width, name: 'authenticated pending request disables native button and prevents duplicate mutation' });
    } finally {
      gate.resolve();
      await authenticated.close();
      signedIn = false;
    }
  }
  assert.deepEqual(report.errors, []);
  console.log('PASS: ProductCard SSR, immediate interactions, keyboard, pending, prices, quantities and reload at 390/1280.');
} finally {
  await writeFile(join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
  console.log('Artifacts: ' + artifacts);
  await browser?.close();
  await web?.close();
  api.closeAllConnections();
  await new Promise(resolve => api.close(resolve));
}
