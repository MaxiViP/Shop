// Production build, loopback fixtures, isolated browser. No production API mutations.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { startWeb } from './browser.mjs';

const baseline = process.env.FIRST_SCREEN_BASELINE === '1';
const measureOnly = process.env.FIRST_SCREEN_MEASURE_ONLY === '1';
const artifacts = await mkdtemp(join(tmpdir(), baseline ? 'korzina-first-before-' : 'korzina-first-after-'));
console.log('Artifacts: ' + artifacts);
const product = { id: 1, slug: 'apple', name: 'Яблоко', price: 10000, priceStatus: 'SOURCE', priceQty: 1,
  unit: 'PIECE', step: 1, min: 1, portionQty: 1, images: [], category: { id: 1, name: 'Фрукты', slug: 'fruits' } };
let signedIn = false;
let cartQty = 0;
const requests = [];
function quote(items) {
  return { items: items.map(line => ({ ...line, product, status: 'AVAILABLE', lineTotal: 10000 * line.qty })),
    subtotal: 10000 * items.reduce((sum, line) => sum + line.qty, 0), valid: true, error: null, token: 'fixture' };
}
const api = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.headers.origin) {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.end();
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
  requests.push({ path, input });
  const user = { id: 1, name: null, phone: '+79990000001', role: 'USER', verifiedAt: new Date().toISOString(), telegram: null };
  let body;
  if (path === '/api/auth/me') body = signedIn ? user : null;
  else if (path === '/api/auth/telegram/config') body = { websiteAvailable: true };
  else if (path === '/api/auth/method') body = { method: 'OTP' };
  else if (path === '/api/auth/code') body = { ok: true };
  else if (path === '/api/auth/login') { signedIn = true; body = user; }
  else if (path === '/api/home/slides') body = { serverNow: new Date().toISOString(), validUntil: new Date(Date.now() + 600_000).toISOString(), slides: [
    { id: 1, content: 'CUSTOM', title: 'Продукты с настоящего рынка', text: 'Выбирайте продукты из разных лавок.',
      image: '/images/hero/hero-0.webp', position: '65% 40%', buttonLabel: 'В каталог', to: '/catalog', endsAt: null },
    { id: 2, content: 'CUSTOM', title: 'Объявление', text: 'Пользовательский слайд', image: '/custom-hero.webp', position: 'left top', endsAt: null },
  ] };
  else if (path === '/api/categories') body = [product.category];
  else if (path === '/api/products') body = { items: [product], total: 1, nextCursor: null, seed: 'fixture', page: 1, pages: 1, limit: 24 };
  else if (path === '/api/orders/quote') body = quote(input.items);
  else if (path === '/api/cart' || path === '/api/cart/change') {
    if (path === '/api/cart/change') {
      assert.equal(input.kind, 'add');
      assert.equal(input.productId, product.id);
      cartQty += input.qty;
    }
    body = { ...quote(cartQty ? [{ productId: product.id, qty: cartQty }] : []), revision: String(cartQty), products: [product] };
  }
  else if (path === '/api/orders/unread') body = { count: 0 };
  else if (path.includes('/favorites')) body = { items: [] };
  else if (path === '/api/order-phones') body = { primaryPhone: null, phones: [] };
  else if (path === '/api/shop/settings') body = { deliveryEnabled: true, pickupEnabled: true, minDeliverySubtotal: 0 };
  else if (path === '/api/orders/queue/offer') body = { showScheduledOffer: false, preorderRequired: false, slots: [], market: { isOpen: true } };
  else body = [];
  res.end(JSON.stringify(body));
});

let web, browser, browserVersion;
const results = [];
try {
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  web = await startWeb(`http://127.0.0.1:${api.address().port}/api`);
  const html = await (await fetch(web.base)).text();
  assert.match(html, /Продукты с настоящего рынка/);
  assert.match(html, /href="\/product\/apple"/);
  if (!baseline) assert.match(html, /fetchpriority="high"/);
  for (const [width, height, dpr] of [[390, 844, 1], [390, 844, 2], [390, 844, 3], [320, 740, 2], [844, 390, 2], [1440, 950, 1]]) {
    // Each scenario starts a fresh process, HTTP cache and V8 code cache.
    browser = await chromium.launch({ executablePath: process.env.CATALOG_BROWSER_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
    browserVersion = browser.version();
    signedIn = false;
    cartQty = 0;
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr, isMobile: width < 1024, hasTouch: width < 1024 });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (/hydration|mismatch/i.test(message.text())) errors.push(message.text()); });
    await page.route('**/custom-hero.webp', route => route.fulfill({ path: fileURLToPath(new URL('../public/images/hero/hero-1.webp', import.meta.url)), contentType: 'image/webp' }));
    await page.addInitScript(() => {
      window.firstScreenTasks = [];
      new PerformanceObserver(list => window.firstScreenTasks.push(...list.getEntries().map(entry => ({ start: entry.startTime, duration: entry.duration })))).observe({ type: 'longtask', buffered: true });
      window.firstScreenLcp = 0;
      window.firstScreenCls = 0;
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) window.firstScreenLcp = entry.startTime;
      }).observe({ type: 'largest-contentful-paint', buffered: true });
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.firstScreenCls += entry.value;
      }).observe({ type: 'layout-shift', buffered: true });
      window.gridLayoutReads = 0;
      const rect = Element.prototype.getBoundingClientRect;
      Element.prototype.getBoundingClientRect = function () {
        if (this.matches('.grid:not([data-windowed])')) window.gridLayoutReads++;
        return rect.call(this);
      };
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const trace = [];
    cdp.on('Tracing.dataCollected', ({ value }) => trace.push(...value));
    await cdp.send('Tracing.start', { categories: 'devtools.timeline,v8.execute,blink.user_timing', transferMode: 'ReportEvents' });
    await page.goto(web.base, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.querySelector('#__nuxt')?.__vue_app__?.config.globalProperties.$nuxt?.isHydrating === false);
    await page.locator('.hero__image').evaluate(image => image.decode());
    const profile = await page.evaluate(() => {
      const image = document.querySelector('.hero__image'), box = image.getBoundingClientRect();
      const resources = performance.getEntriesByType('resource');
      const tasks = window.firstScreenTasks;
      return { width: innerWidth, dpr: devicePixelRatio, gridLayoutReads: window.gridLayoutReads,
        headerElements: document.querySelectorAll('.header *').length,
        lcp: window.firstScreenLcp, cls: window.firstScreenCls,
        hero: { url: new URL(image.currentSrc).pathname, width: box.width, height: box.height,
        sizes: image.sizes, position: getComputedStyle(image).objectPosition, bytes: resources.find(entry => entry.name === image.currentSrc)?.encodedBodySize },
        heroResources: resources.filter(entry => /\/images\/hero\/hero-0[^/]*\.(avif|webp)$/.test(new URL(entry.name).pathname))
          .map(entry => ({ path: new URL(entry.name).pathname, bytes: entry.encodedBodySize })),
        scripts: resources.filter(entry => /\/_nuxt\/.*\.js/.test(entry.name)).map(entry => ({ path: new URL(entry.name).pathname, bytes: entry.encodedBodySize })),
        tasks, maxTask: Math.max(0, ...tasks.map(entry => entry.duration)), blockingTime: tasks.reduce((sum, task) => sum + Math.max(0, task.duration - 50), 0),
        paints: performance.getEntriesByType('paint').map(entry => ({ name: entry.name, ms: entry.startTime })) };
    });
    const traceComplete = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve));
    await cdp.send('Tracing.end');
    await traceComplete;
    await writeFile(join(artifacts, `trace-${width}-${dpr}.json`), JSON.stringify({ traceEvents: trace }));
    await page.screenshot({ path: join(artifacts, `home-${width}-${dpr}.png`) });
    assert.equal(profile.hero.position, '65% 40%');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (!baseline) {
      assert.ok(profile.hero.bytes > 0 && profile.hero.bytes < 160000, JSON.stringify(profile.hero));
      assert.equal(profile.gridLayoutReads, 0, 'non-virtual grids must not measure layout');
    }
    assert.deepEqual(errors, []);
    if (baseline || measureOnly) {
      results.push(profile);
      console.log(JSON.stringify({ width, height, dpr, bytes: profile.hero.bytes, scripts: profile.scripts.reduce((sum, entry) => sum + entry.bytes, 0), maxTask: profile.maxTask, blockingTime: profile.blockingTime }));
      await context.close(); await browser.close(); browser = undefined; continue;
    }
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await page.getByRole('button', { name: 'Следующий слайд', exact: true }).click();
    await page.waitForFunction(() => {
      const image = document.querySelector('.hero__image');
      return image?.getAttribute('src') === '/custom-hero.webp' && image.complete && image.naturalWidth > 0;
    });
    assert.deepEqual(await page.locator('.hero__image').evaluate(image => ({
      srcset: image.getAttribute('srcset'), position: getComputedStyle(image).objectPosition,
      sources: image.parentElement.querySelectorAll('source').length,
    })), { srcset: null, position: '0% 0%', sources: 0 });
    const menu = page.locator('.header__menu');
    if (await menu.isVisible()) {
      // Delay the first import so the first click and a quick second click are exercised.
      if (!baseline) await page.route('**/_nuxt/*.js', async route => { await new Promise(resolve => setTimeout(resolve, 100)); await route.continue(); });
      await menu.click();
      await menu.evaluate(element => element.click());
      assert.equal(await menu.getAttribute('aria-expanded'), 'false');
      await menu.click();
      await page.locator('#mobile-menu').waitFor({ state: 'visible' });
      await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.contains(document.activeElement));
      await page.keyboard.press('Escape');
      await page.locator('#mobile-menu').waitFor({ state: 'hidden' });
      await page.waitForFunction(() => document.activeElement === document.querySelector('.header__menu'));
      await menu.click();
      await page.locator('#mobile-menu').waitFor({ state: 'visible' });
      await page.locator('#mobile-menu').getByRole('button', { name: 'Войти', exact: true }).click();
    } else await page.locator('.header__profile').click();
    const dialog = page.getByRole('dialog');
    await dialog.getByPlaceholder('+7 (___) ___-__-__').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('[role="dialog"] .auth')?.contains(document.activeElement));
    await dialog.getByPlaceholder('+7 (___) ___-__-__').fill('+79990000001');
    await dialog.getByRole('button', { name: 'Получить код', exact: true }).waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.activeElement === document.querySelector(
      getComputedStyle(document.querySelector('.header__menu')).display === 'none' ? '.header__profile' : '.header__menu',
    ));
    if (await menu.isVisible()) {
      await menu.click();
      await page.locator('#mobile-menu').getByRole('button', { name: 'Войти', exact: true }).click();
    } else await page.locator('.header__profile').click();
    assert.equal((await dialog.getByPlaceholder('+7 (___) ___-__-__').inputValue()).replace(/\D/g, ''), '79990000001');
    await dialog.getByRole('button', { name: 'Получить код', exact: true }).click();
    await dialog.getByRole('textbox', { name: 'Код подтверждения' }).fill('123456');
    await dialog.getByRole('button', { name: 'Войти', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.ok(requests.some(request => request.path === '/api/auth/login' && request.input.code === '123456'));
    await page.locator('.card__add').click();
    await page.waitForFunction(() => document.querySelector('.cart-control__amount')?.textContent.includes('100'));
    await page.locator('.cart-control').click();
    await page.waitForURL('**/cart');
    assert.match(await page.locator('.cart-control__amount').innerText(), /100\s₽/);
    assert.deepEqual(errors, []);
    results.push(profile);
    console.log(JSON.stringify({ width, height, dpr, bytes: profile.hero.bytes, scripts: profile.scripts.reduce((sum, entry) => sum + entry.bytes, 0), maxTask: profile.maxTask, blockingTime: profile.blockingTime, interactions: true }));
    await context.close();
    await browser.close(); browser = undefined;
  }
  await writeFile(join(artifacts, 'results.json'), JSON.stringify({ baseline, measureOnly, cpuThrottle: 4,
    network: 'loopback, no network throttle, HTTP cache disabled', node: process.version,
    browser: browserVersion, results }, null, 2));
  console.log((baseline ? 'PASS: first-screen baseline. Artifacts: ' : 'PASS: SSR, responsive/custom hero, rapid menu toggles, focus, login, OTP and cart. Artifacts: ') + artifacts);
} finally {
  await browser?.close();
  await web?.close();
  api.closeAllConnections(); await new Promise(resolve => api.close(resolve));
}
