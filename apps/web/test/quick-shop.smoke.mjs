// Production-build smoke with a loopback fixture API and a fresh browser profile.
// Run after rebuilding web: node apps/web/test/quick-shop.smoke.mjs
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { startWeb } from './browser.mjs';

const artifacts = await mkdtemp(join(tmpdir(), 'korzina-quick-shop-'));
const category = { name: 'Тестовые продукты', slug: 'fixture' };
const common = { priceStatus: 'SOURCE', unit: 'GRAM', priceUnit: 'GRAM', saleModel: 'WEIGHT_LOOSE',
  priceQty: 1000, min: 250, step: 250, portionQty: 500, estimatedWeightGrams: null,
  isSeasonal: false, isHit: false, seasonalStartsAt: null, seasonalEndsAt: null,
  marketPoint: null, category, images: [] };
const products = [
  { ...common, id: 1, slug: 'pink-tomatoes', name: 'Помидоры розовые', price: 32000 },
  { ...common, id: 2, slug: 'cucumbers', name: 'Огурцы', price: 24000 },
  { ...common, id: 3, slug: 'whole-fish', name: 'Рыба целиком', price: 65000, unit: 'PIECE',
    saleModel: 'WHOLE_VARIABLE_WEIGHT', min: 1, step: 1, portionQty: 1 },
  { ...common, id: 4, slug: 'dill', name: 'Укроп', price: 7000, unit: 'BUNCH', priceUnit: 'BUNCH',
    saleModel: 'BUNCH', priceQty: 1, min: 1, step: 1, portionQty: 1 },
  { ...common, id: 5, slug: 'carrots', name: 'Морковь', price: 4000 },
];
const report = { checks: [], errors: [], fixtureErrors: [] };
let fixture;
function resetFixture() {
  fixture = { cart: new Map([[1, 750]]), revision: randomUUID(), reads: 0, quickReads: 0, changes: [], repeats: [],
    searches: [], quotes: [], failure: null, gate: null, quoteGate: null, userId: 7 };
  products[4].price = 4000;
}
resetFixture();
function quote(items) {
  const lines = items.map(item => {
    const product = products.find(product => product.id === item.productId);
    assert.ok(product, 'Fixture quote product');
    const lineTotal = product.unit !== 'GRAM' && product.priceUnit === 'GRAM' ? null
      : Math.round(product.price * item.qty / product.priceQty);
    return { productId: product.id, qty: item.qty, quantityUnit: product.unit, product,
      status: 'AVAILABLE', lineTotal };
  });
  const pendingWeight = lines.some(line => line.lineTotal === null);
  const knownSubtotal = lines.reduce((total, line) => total + (line.lineTotal ?? 0), 0);
  const subtotal = pendingWeight ? null : knownSubtotal;
  return { items: lines, subtotal, goodsTotal: subtotal, knownSubtotal, pendingWeight,
    valid: true, error: null, token: 'fixture-quote', promo: null, promoCodes: [],
    delivery: { enabled: false, threshold: null, remaining: null, progress: 0,
      eligible: false, price: null, total: null } };
}
function snapshot(cart = fixture.cart, revision = fixture.revision) {
  const result = quote([...cart].map(([productId, qty]) => ({ productId, qty })));
  return { ...result, revision, products: result.items.map(line => line.product) };
}
const reply = (response, body, status = 200) => {
  response.statusCode = status;
  response.end(JSON.stringify(body));
};
const api = createServer(async (request, response) => {
  response.setHeader('Content-Type', 'application/json');
  response.setHeader('Cache-Control', 'no-store');
  if (request.headers.origin) {
    assert.match(request.headers.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    response.setHeader('Access-Control-Allow-Origin', request.headers.origin);
    response.setHeader('Access-Control-Allow-Credentials', 'true');
    response.setHeader('Access-Control-Allow-Headers', 'content-type');
    response.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  }
  if (request.method === 'OPTIONS') return response.end();
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    const path = url.pathname;
    let input;
    if (request.method === 'POST') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      input = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    }
    if (path === '/api/auth/me') return reply(response, { id: fixture.userId, name: 'Тестовый покупатель',
      phone: '+79990000007', role: 'USER', verifiedAt: '2026-10-22T09:00:00Z', telegram: null });
    if (path === '/api/cart' && request.method === 'GET') {
      fixture.reads++;
      return reply(response, snapshot());
    }
    if (path === '/api/cart/quick-shop') {
      fixture.quickReads++;
      return reply(response, {
      // The recommendation snapshot is deliberately older. Restoration must use /cart.
      cart: snapshot(new Map([[1, 250]]), randomUUID()),
      items: products.slice(0, 4).map((product, index) => ({ product,
        source: index === 0 ? 'frequent' : index === 1 ? 'favorite' : 'catalog',
        suggestedQty: product.portionQty,
        lineTotal: quote([{ productId: product.id, qty: product.portionQty }]).items[0].lineTotal })),
      lastOrder: { id: 128, createdAt: '2026-10-21T09:00:00Z', itemCount: 3 },
      });
    }
    if (path === '/api/cart/change') {
      assert.deepEqual(Object.keys(input).sort(), (input.kind === 'remove' ? ['kind', 'productId', 'revision'] : ['kind', 'productId', 'qty', 'quantityUnit', 'revision']).sort());
      fixture.changes.push(input);
      const gate = fixture.gate;
      fixture.gate = null;
      if (gate) await gate.promise;
      assert.equal(input.revision, fixture.revision, 'Mutation uses the last acknowledged revision');
      if (fixture.failure === 'stale') {
        fixture.failure = null;
        fixture.cart.set(1, 1500);
        fixture.revision = randomUUID();
        return reply(response, { statusCode: 409, message: 'Корзина изменилась в другом окне' }, 409);
      }
      if (fixture.failure === 'rejected') {
        fixture.failure = null;
        return reply(response, { statusCode: 400, message: 'Товар временно недоступен' }, 400);
      }
      const product = products.find(product => product.id === input.productId);
      assert.ok(product);
      if (input.kind === 'remove') fixture.cart.delete(input.productId);
      else {
        assert.equal(input.kind, 'set');
        assert.equal(input.quantityUnit, product.unit);
        assert.ok(Number.isSafeInteger(input.qty) && input.qty >= product.min && (input.qty - product.min) % product.step === 0);
        fixture.cart.set(input.productId, input.qty);
      }
      fixture.revision = randomUUID();
      if (fixture.failure === 'lost') {
        fixture.failure = null;
        // Deliver response headers before losing the body. Closing a reused
        // connection without any response can trigger Chromium's TCP retry.
        response.writeHead(200);
        response.flushHeaders();
        response.write('{', () => response.destroy());
        return;
      }
      return reply(response, snapshot());
    }
    if (path === '/api/cart/repeat') {
      fixture.repeats.push(input);
      assert.deepEqual(Object.keys(input).sort(), ['orderId', 'revision']);
      assert.equal(input.revision, fixture.revision);
      if (![127, 128].includes(input.orderId)) return reply(response, { statusCode: 404, message: 'Заказ не найден' }, 404);
      const before = fixture.cart.get(1);
      const added = fixture.cart.has(4) ? 0 : 1;
      if (added) fixture.cart.set(4, 2);
      assert.equal(fixture.cart.get(1), before, 'Repeat keeps existing quantities');
      fixture.revision = randomUUID();
      return reply(response, { cart: snapshot(), orderId: input.orderId, added, skipped: [
        { productId: 1, name: products[0].name, reason: 'Уже есть в корзине: количество сохранено' },
        { productId: 99, name: 'Авокадо', reason: 'Товар больше недоступен' },
      ] });
    }
    if (path === '/api/products') {
      const query = url.searchParams.get('q') ?? '';
      fixture.searches.push(query);
      const items = products.filter(product => product.name.toLocaleLowerCase('ru-RU').includes(query.toLocaleLowerCase('ru-RU')));
      return reply(response, { items, total: items.length, page: 1, pages: 1, limit: 24, nextCursor: null });
    }
    if (path === '/api/orders/quote') {
      fixture.quotes.push(input);
      const gate = fixture.quoteGate;
      fixture.quoteGate = null;
      if (gate) await gate.promise;
      return reply(response, quote(input.items));
    }
    if (path === '/api/favorites') return reply(response, { items: [products[1], products[4]] });
    if (path === '/api/notifications') return reply(response, { scope: `fixture-user-${fixture.userId}`, events: [], hasMore: false });
    if (path === '/api/orders/unread') return reply(response, { count: 0 });
    if (path === '/api/order-phones') return reply(response, { primaryPhone: null, phones: [] });
    if (path === '/api/shop/settings') return reply(response, { deliveryEnabled: false, pickupEnabled: true, minDeliverySubtotal: 0 });
    throw new Error('Unexpected fixture endpoint: ' + request.method + ' ' + path);
  } catch (error) {
    report.fixtureErrors.push(error.message);
    if (!response.writableEnded) reply(response, { message: 'Fixture failure' }, 500);
  }
});

let web, browser;
try {
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  web = await startWeb(`http://127.0.0.1:${api.address().port}/api`);
  browser = await chromium.launch({
    executablePath: process.env.CATALOG_BROWSER_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true,
  });
  for (const width of [320, 390, 1280]) {
    resetFixture();
    const context = await browser.newContext({ viewport: { width, height: 900 },
      deviceScaleFactor: 1, isMobile: width < 600, hasTouch: width < 600 });
    await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('console', message => { if (/hydration|mismatch/i.test(message.text())) report.errors.push(message.text()); });
    const row = id => page.locator(`article[aria-labelledby="quick-item-${id}"]`);
    const quantity = id => row(id).locator('.quick-item__quantity strong');
    const footer = page.locator('.quick-shop__cart');
    const check = name => report.checks.push({ width, name });
    let pendingGate;
    try {
      await page.goto(web.base + '/quick-shop', { waitUntil: 'networkidle' });
      await expect(page.getByRole('heading', { name: 'Быстрые покупки', exact: true })).toBeVisible();
      await expect(quantity(1)).toHaveText('750 г');
      await expect(row(2).getByRole('button', { name: 'Добавить 500 г', exact: true })).toBeEnabled();
      assert.equal(fixture.changes.length, 0);
      await expect(footer.locator('strong')).toHaveText(/240\s*₽/);
      await page.screenshot({ path: join(artifacts, `quick-shop-initial-${width}.png`), fullPage: true });
      if (width === 390) await page.screenshot({ path: join(artifacts, 'quick-shop-mobile.png') });
      check('USER restoration uses current server cart instead of the older recommendation snapshot');

      pendingGate = Promise.withResolvers();
      fixture.quoteGate = pendingGate;
      const quoteSeen = page.waitForRequest(request => new URL(request.url()).pathname === '/api/orders/quote');
      const quickReads = fixture.quickReads;
      await page.getByRole('button', { name: 'Избранное', exact: true }).click();
      await quoteSeen;
      const refresh = page.getByRole('button', { name: 'Обновить список и корзину', exact: true });
      await expect(refresh).toBeDisabled();
      await refresh.evaluate(button => button.click());
      assert.equal(fixture.quickReads, quickReads, 'Refresh cannot invalidate an in-flight favorites request');
      pendingGate.resolve();
      await expect(row(5)).toBeVisible();
      await expect(refresh).toBeEnabled();
      await expect(page.locator('article.quick-item')).toHaveCount(2);
      await expect(row(2)).toBeVisible();
      await page.getByRole('button', { name: /^В корзине\s*·?\s*1$/ }).click();
      await expect(page.locator('article.quick-item')).toHaveCount(1);
      await expect(row(1)).toBeVisible();
      await page.getByRole('button', { name: 'Мои продукты', exact: true }).click();
      await expect(page.locator('article.quick-item')).toHaveCount(4);
      check('full favorites include saved products outside recommendations; refresh stays disabled during their quote');

      await row(2).getByRole('button', { name: 'Добавить 500 г', exact: true }).click();
      await expect(quantity(2)).toHaveText('500 г');
      assert.equal(fixture.changes.length, 1);
      await expect(footer.locator('strong')).toHaveText(/360\s*₽/);
      await expect(row(2).locator('.quick-item__receipt')).toContainText(/Огурцы: добавлено \+500 г.*\+120\s*₽/);
      check('first add sends one mutation and displays the acknowledged line and cart total');

      const gate = pendingGate = Promise.withResolvers();
      fixture.gate = gate;
      const plus = row(1).getByRole('button', { name: 'Добавить 250 г: Помидоры розовые', exact: true });
      const seen = page.waitForRequest(request => new URL(request.url()).pathname === '/api/cart/change');
      await plus.click();
      await seen;
      await expect(plus).toBeDisabled();
      await plus.evaluate(button => button.click());
      gate.resolve();
      await expect(quantity(1)).toHaveText('1 кг');
      await expect(plus).toBeEnabled();
      assert.equal(fixture.changes.length, 2);
      await expect(footer.locator('strong')).toHaveText(/440\s*₽/);
      await expect(row(1).locator('.quick-item__receipt')).toContainText(/добавлено \+250 г.*\+80\s*₽/);
      check('step mutation is pending-safe and reports only the server-confirmed delta');

      await row(1).getByRole('button', { name: 'Установить точное количество: Помидоры розовые', exact: true }).click();
      await row(1).locator('#quick-qty-1').fill('751');
      await row(1).getByRole('button', { name: 'Сохранить', exact: true }).click();
      await expect(row(1).getByRole('alert')).toContainText('шаг 250 г');
      assert.equal(fixture.changes.length, 2, 'Invalid exact grams must not reach the API');
      await row(1).locator('#quick-qty-1').fill('1250');
      await row(1).getByRole('button', { name: 'Сохранить', exact: true }).click();
      await expect(quantity(1)).toHaveText('1,25 кг');
      assert.equal(fixture.changes.length, 3);
      await expect(footer.locator('strong')).toHaveText(/520\s*₽/);
      check('exact grams reject non-step values locally and save a valid total once');

      const reads = fixture.reads;
      fixture.failure = 'stale';
      await plus.click();
      await expect(quantity(1)).toHaveText('1,5 кг');
      await expect(plus).toBeEnabled();
      await expect(page.getByText('Не удалось подтвердить изменение. Проверьте текущий состав корзины перед повторным действием.', { exact: true })).toBeVisible();
      assert.equal(fixture.changes.length, 4, '409 is never replayed');
      assert.ok(fixture.reads > reads, '409 refreshes the authoritative cart');
      await expect(page.locator('.quick-shop__notice')).toHaveCount(0);
      fixture.failure = 'rejected';
      await plus.click();
      await expect(plus).toBeEnabled();
      await expect(quantity(1)).toHaveText('1,5 кг');
      assert.equal(fixture.changes.length, 5, '400 is never replayed');
      assert.equal(fixture.cart.get(1), 1500);
      check('409 refreshes without retry; rejected mutations retain the last acknowledged quantities');

      await page.getByRole('button', { name: 'Повторить', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Состав заказа восстановлен', exact: true })).toBeVisible();
      await expect(quantity(1)).toHaveText('1,5 кг');
      await expect(quantity(4)).toHaveText('2 пучка');
      await expect(page.locator('.quick-shop__review')).toContainText('Уже есть в корзине: количество сохранено');
      await expect(page.locator('.quick-shop__review')).toContainText('Авокадо: Товар больше недоступен');
      assert.equal(fixture.repeats.length, 1);
      assert.equal(fixture.changes.length, 5);
      assert.deepEqual([...fixture.cart], [[1, 1500], [2, 500], [4, 2]]);
      check('repeat adds absent products only, preserves existing quantities and explains skipped items');

      await page.getByRole('button', { name: 'Мои продукты', exact: true }).click();
      await row(3).getByRole('button', { name: 'Добавить 1 шт.', exact: true }).click();
      await expect(quantity(3)).toHaveText('1 шт.');
      await expect(row(3).locator('.quick-item__total strong')).toHaveText('После взвешивания');
      await expect(footer.locator('strong')).toHaveText('После взвешивания');
      await expect(footer).toContainText('Известная часть:');
      assert.equal(fixture.changes.length, 6);
      assert.ok(!/\+0\s*₽/.test(await row(3).locator('.quick-item__receipt').innerText()));
      check('whole weighted goods retain an unknown amount and show the known portion separately');

      await page.locator('#quick-search').fill('Морковь');
      await expect(row(5)).toBeVisible();
      await expect(page.locator('article.quick-item')).toHaveCount(1);
      assert.ok(fixture.searches.includes('Морковь'));
      assert.equal(fixture.quotes.at(-1).items[0].productId, 5);
      await expect(row(5).locator('.quick-item__total strong')).toHaveText(/20\s*₽/);
      await row(5).getByRole('button', { name: 'Добавить 500 г', exact: true }).click();
      await expect(quantity(5)).toHaveText('500 г');
      assert.equal(fixture.changes.length, 7);
      await page.getByRole('button', { name: 'Очистить поиск', exact: true }).click();
      await expect(page.locator('article.quick-item')).toHaveCount(5);
      check('search gets prospective server quotes and adds products outside the recommendation list');

      const checkout = footer.getByRole('link', { name: 'Проверить заказ', exact: true });
      await expect(checkout).toHaveAttribute('href', '/cart');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'No horizontal overflow');
      await page.screenshot({ path: join(artifacts, `quick-shop-${width}.png`), fullPage: true });
      await page.reload({ waitUntil: 'networkidle' });
      await expect(quantity(1)).toHaveText('1,5 кг');
      await expect(quantity(3)).toHaveText('1 шт.');
      await expect(quantity(5)).toHaveText('500 г');
      assert.equal(fixture.changes.length, 7, 'Reload must not replay mutations');
      check('safe cart checkout link, responsive layout and server cart restoration after reload');

      const undoTomato = () => row(1).getByRole('button', { name: 'Вернуть предыдущее количество: Помидоры розовые', exact: true });
      let mutations = fixture.changes.length;
      await plus.click();
      await expect(quantity(1)).toHaveText('1,75 кг');
      await expect(undoTomato()).toBeEnabled();
      // Another client changes a different item after the acknowledged addition.
      fixture.cart.set(4, 3); fixture.revision = randomUUID();
      const freshRevision = fixture.revision;
      await undoTomato().click();
      await expect(quantity(1)).toHaveText('1,5 кг');
      await expect(quantity(4)).toHaveText('3 пучка');
      assert.equal(fixture.changes.length, mutations + 2);
      assert.equal(fixture.changes.at(-1).revision, freshRevision);
      await expect(row(1).locator('.quick-item__receipt')).toContainText('Возврат выполнен');
      await expect(undoTomato()).toHaveCount(0);
      check('near-item undo reads the current revision, changes only its product and preserves another client edit');

      await plus.click();
      await expect(quantity(1)).toHaveText('1,75 кг');
      mutations = fixture.changes.length;
      fixture.cart.set(1, 1250); fixture.revision = randomUUID();
      await undoTomato().click();
      await expect(quantity(1)).toHaveText('1,25 кг');
      await expect(page.getByText('Этот товар уже изменился. Проверьте его количество: возврат отменён.', { exact: true })).toBeVisible();
      assert.equal(fixture.changes.length, mutations, 'Undo cannot overwrite a later edit to the same product');
      check('undo refuses to overwrite a newer quantity from another client');

      fixture.failure = 'lost';
      mutations = fixture.changes.length;
      await plus.click();
      await expect(quantity(1)).toHaveText('1,5 кг');
      await expect(plus).toBeEnabled();
      await expect(page.getByText('Не удалось подтвердить изменение. Проверьте текущий состав корзины перед повторным действием.', { exact: true })).toBeVisible();
      assert.equal(fixture.changes.length, mutations + 1, 'Lost mutation response must only be followed by GET');
      await expect(page.locator('.quick-item__receipt')).toHaveCount(0);
      check('a response lost after commit refreshes the cart without replaying POST or offering a speculative undo');

      await row(5).getByRole('button', { name: 'Уменьшить Морковь на 250 г', exact: true }).click();
      await expect(quantity(5)).toHaveText('250 г');
      await row(5).getByRole('button', { name: 'Уменьшить Морковь на 250 г', exact: true }).click();
      await expect(row(5)).toHaveCount(0);
      await expect(page.locator('.quick-shop__notice')).toContainText('Товар удалён из корзины');
      await page.locator('.quick-shop__notice').getByRole('button', { name: 'Вернуть', exact: true }).click();
      await expect(quantity(5)).toHaveText('250 г');
      check('removing an item still offers undo when it disappears from the visible list');

      await page.getByRole('button', { name: 'Избранное', exact: true }).click();
      await page.locator('#quick-search').fill('Морковь');
      await expect(row(5)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Обновить список и корзину', exact: true })).toBeEnabled();
      mutations = fixture.changes.length;
      fixture.userId = 8;
      await page.goto(web.base + '/quick-shop', { waitUntil: 'networkidle' });
      await expect(page.locator('#quick-search')).toHaveValue('');
      await expect(page.getByRole('button', { name: 'Мои продукты', exact: true })).toHaveAttribute('aria-pressed', 'true');
      fixture.userId = 7; products[4].price = 8000; fixture.cart.set(5, 1000); fixture.revision = randomUUID();
      await page.goto(web.base + '/quick-shop', { waitUntil: 'networkidle' });
      await expect(page.locator('#quick-search')).toHaveValue('Морковь');
      await expect(page.getByRole('button', { name: 'Избранное', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await expect(quantity(5)).toHaveText('1 кг');
      await expect(row(5).locator('.quick-item__total strong')).toHaveText(/80\s*₽/);
      assert.equal(fixture.changes.length, mutations, 'Restoring navigation does not replay cart actions');
      const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem('quick-shop:7')));
      assert.deepEqual(Object.keys(saved).sort(), ['version', 'filter', 'query', 'scroll'].sort());
      check('search and tab restore only for their account, while quantities and prices reload from the server');

      await page.getByRole('button', { name: 'Очистить поиск', exact: true }).click();
      await page.getByRole('button', { name: 'Мои продукты', exact: true }).click();
      await expect(page.locator('article.quick-item')).toHaveCount(5);
      await page.evaluate(() => window.scrollTo(0, 300));
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(50);
      const scroll = await page.evaluate(() => window.scrollY);
      await page.goto(web.base + '/quick-shop', { waitUntil: 'networkidle' });
      await expect(quantity(5)).toHaveText('1 кг');
      await expect.poll(() => page.evaluate(target => Math.abs(window.scrollY - target), scroll)).toBeLessThan(3);
      check('return restores scroll after the current server cart and list are ready');

      const repeats = fixture.repeats.length;
      await page.goto(web.base + '/quick-shop?orderId=127', { waitUntil: 'networkidle' });
      await expect(page.getByRole('heading', { name: 'Повторить заказ №127?', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Повторить', exact: true })).toBeEnabled();
      assert.equal(fixture.repeats.length, repeats, 'Opening a selected order is read-only');
      await page.getByRole('button', { name: 'Повторить', exact: true }).click();
      await expect(page.locator('.quick-shop__notice')).toContainText('Заказ №127');
      assert.equal(fixture.repeats.length, repeats + 1);
      assert.equal(fixture.repeats.at(-1).orderId, 127);
      await expect(quantity(4)).toHaveText('3 пучка');
      await page.goto(web.base + '/quick-shop?orderId=999', { waitUntil: 'networkidle' });
      await expect(page.getByRole('heading', { name: 'Повторить заказ №999?', exact: true })).toBeVisible();
      assert.equal(fixture.repeats.length, repeats + 1);
      await page.getByRole('button', { name: 'Повторить', exact: true }).click();
      await expect(page.getByText('Результат повторения не подтверждён. Товары могли уже добавиться: проверьте корзину перед повторным действием.', { exact: true })).toBeVisible();
      assert.equal(fixture.repeats.length, repeats + 2, 'A rejected selected order is never retried');
      check('selected order repeat requires an explicit action and preserves server ownership rejection');
    } finally {
      pendingGate?.resolve();
      fixture.gate?.resolve();
      fixture.quoteGate?.resolve();
      await context.close();
    }
  }
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.fixtureErrors, []);
  console.log(`PASS: quick-shop ${report.checks.length} checks at 320/390/1280; restoration, server totals, exact grams, filters/search, repeat and stale responses.`);
} finally {
  await writeFile(join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
  console.log('Artifacts: ' + artifacts);
  await browser?.close();
  await web?.close();
  api.closeAllConnections();
  await new Promise(resolve => api.close(resolve));
}
