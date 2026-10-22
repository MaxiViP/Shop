// Run against a freshly built web production bundle; fixture traffic stays on loopback.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { startWeb } from './browser.mjs';

const artifacts = await mkdtemp(join(tmpdir(), 'korzina-staff-weigh-'));
const report = { checks: [], errors: [], fixtureErrors: [] };
const common = { status: 'PENDING', actualQty: null, actualWeightGrams: null, pieceWeights: null,
  actualTotal: null, actualPrice: null, actualSellerPrice: null, serviceMarkupPercentSnapshot: 0,
  image: null, weightMinGrams: null, weightMaxGrams: null, estimatedWeightGrams: null };
const originals = [
  { ...common, id: 10, productName: 'Помидоры розовые', productSlug: 'pink-tomatoes', unit: 'GRAM',
    priceUnit: 'GRAM', saleModel: 'WEIGHT_LOOSE', qty: 750, price: 32000, priceQty: 1000, total: 24000 },
  { ...common, id: 11, productName: 'Рыба целиком', productSlug: 'whole-fish', unit: 'PIECE',
    priceUnit: 'GRAM', saleModel: 'WHOLE_VARIABLE_WEIGHT', qty: 2, price: 65000, priceQty: 1000,
    total: null, weightMinGrams: 500, weightMaxGrams: 900 },
  { ...common, id: 14, productName: 'Вторая целая рыба', productSlug: 'other-fish', unit: 'PIECE',
    priceUnit: 'GRAM', saleModel: 'WHOLE_VARIABLE_WEIGHT', qty: 2, price: 55000, priceQty: 1000,
    total: null, weightMinGrams: 500, weightMaxGrams: 900 },
  { ...common, id: 12, productName: 'Укроп', productSlug: 'dill', unit: 'BUNCH',
    priceUnit: 'BUNCH', saleModel: 'BUNCH', qty: 1, price: 7000, priceQty: 1, total: 7000 },
  { ...common, id: 13, productName: 'Ожидает ответа', productSlug: 'waiting', unit: 'GRAM',
    priceUnit: 'GRAM', saleModel: 'WEIGHT_LOOSE', qty: 500, price: 10000, priceQty: 1000, total: 5000 },
];
let fixture;
function resetFixture() {
  fixture = { items: structuredClone(originals), issues: [{ id: 80, orderItemId: 13, replacementItemId: null,
    status: 'WAITING_CUSTOMER', type: 'MISSING_ITEM', resolution: null, version: 1 }],
    quotes: [], mutations: [], reads: 0, quoteGate: null, mutationGate: null, unknown: false };
}
function order() {
  return { id: 128, publicId: '11111111-1111-4111-8111-111111111128', type: 'PICKUP', status: 'ASSEMBLING',
    customerName: 'Тестовый покупатель', customerPhone: '+79990000128', city: null, street: null,
    house: null, flat: null, entrance: null, floor: null, intercom: null, comment: null,
    fulfillmentMode: 'ASAP', scheduledFor: null, assemblyStartedAt: '2026-10-22T09:00:00Z',
    createdAt: '2026-10-22T08:55:00Z', updatedAt: '2026-10-22T09:00:00Z', deliveryAt: null,
    subtotal: null, total: null, finalSubtotal: null, finalTotal: null, deliveryPrice: 0,
    delivery: null, payment: null, paymentDetails: null, weightToleranceBps: 1000,
    preparationMinutes: 20, assemblyFinalizedAt: null, queue: null, freeDeliveryApplied: false,
    cancellations: [], restoreProblem: null, extras: [], items: structuredClone(fixture.items),
    issues: structuredClone(fixture.issues), ...fixture.orderChanges };
}
function quote(item, input) {
  assert.equal(input.status, 'PICKED');
  assert.ok(Number.isSafeInteger(input.actualQty) && input.actualQty > 0 && input.actualQty <= 1_000_000);
  const whole = item.unit !== 'GRAM' && item.priceUnit === 'GRAM';
  if (whole) {
    assert.equal(input.pieceWeights?.length, input.actualQty);
    assert.ok(input.actualQty <= 100 && input.pieceWeights.every(value => Number.isInteger(value) && value > 0));
  } else assert.equal(input.pieceWeights, undefined);
  const actualWeightGrams = whole ? input.pieceWeights.reduce((sum, value) => sum + value, 0) : null;
  const actualTotal = Math.round((item.actualPrice ?? item.price) * (actualWeightGrams ?? input.actualQty) / item.priceQty);
  const requiresApproval = whole ? input.actualQty !== item.qty || input.pieceWeights.some(value =>
    (item.weightMinGrams !== null && value < item.weightMinGrams) || (item.weightMaxGrams !== null && value > item.weightMaxGrams))
    : item.unit === 'GRAM' ? input.actualQty < item.qty * .9 || input.actualQty > item.qty * 1.1 : input.actualQty !== item.qty;
  return { actualQty: input.actualQty, actualWeightGrams, actualTotal,
    quantityDelta: input.actualQty - item.qty, amountDelta: item.total === null ? null : actualTotal - item.total,
    requiresApproval };
}
const reply = (response, body, status = 200) => { response.statusCode = status; response.end(JSON.stringify(body)); };
resetFixture();
const api = createServer(async (request, response) => {
  response.setHeader('Content-Type', 'application/json'); response.setHeader('Cache-Control', 'no-store');
  if (request.headers.origin) {
    assert.match(request.headers.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    response.setHeader('Access-Control-Allow-Origin', request.headers.origin);
    response.setHeader('Access-Control-Allow-Credentials', 'true');
    response.setHeader('Access-Control-Allow-Headers', 'content-type');
    response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  }
  if (request.method === 'OPTIONS') return response.end();
  try {
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    let input;
    if (['POST', 'PATCH'].includes(request.method)) {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      input = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    }
    if (path === '/api/auth/me') return reply(response, { id: 7, role: 'SELLER', name: 'Тестовый продавец',
      phone: '+79990000007', verifiedAt: '2026-10-22T09:00:00Z', telegram: null });
    if (path === '/api/staff/orders/128' && request.method === 'GET') {
      fixture.reads++;
      return fixture.readFailure ? reply(response, { message: 'Заказ временно недоступен' }, 503) : reply(response, order());
    }
    const itemRoute = /^\/api\/staff\/orders\/128\/items\/(\d+)(\/quote)?$/.exec(path);
    if (itemRoute) {
      const item = fixture.items.find(item => item.id === Number(itemRoute[1]));
      assert.ok(item, 'Known fixture order item');
      if (itemRoute[2]) {
        assert.equal(request.method, 'POST');
        assert.equal(item.status, 'PENDING');
        assert.deepEqual(Object.keys(input).sort(), item.unit !== 'GRAM' && item.priceUnit === 'GRAM'
          ? ['actualQty', 'pieceWeights', 'status'] : ['actualQty', 'status']);
        fixture.quotes.push({ itemId: item.id, ...input });
        const result = quote(item, input), gate = fixture.quoteGate; fixture.quoteGate = null;
        if (gate) await gate.promise;
        return reply(response, result);
      }
      assert.equal(request.method, 'PATCH');
      fixture.mutations.push({ itemId: item.id, ...input });
      const gate = fixture.mutationGate; fixture.mutationGate = null;
      if (gate) await gate.promise;
      if (input.status === 'PICKED') {
        const result = quote(item, input);
        Object.assign(item, { status: 'PICKED', actualQty: result.actualQty,
          actualWeightGrams: result.actualWeightGrams, pieceWeights: input.pieceWeights ?? null, actualTotal: result.actualTotal });
        if (result.requiresApproval) fixture.issues.push({ id: 100 + item.id, orderItemId: item.id,
          replacementItemId: null, status: 'WAITING_CUSTOMER', type: 'WEIGHT_DEVIATION', resolution: null, version: 1 });
      } else {
        assert.ok(['PENDING', 'MISSING'].includes(input.status));
        Object.assign(item, { status: input.status, actualQty: null, actualWeightGrams: null, pieceWeights: null, actualTotal: null });
        fixture.issues = fixture.issues.filter(issue => issue.orderItemId !== item.id);
        if (input.status === 'MISSING') fixture.issues.push({ id: 100 + item.id, orderItemId: item.id,
          replacementItemId: null, status: 'WAITING_CUSTOMER', type: 'MISSING_ITEM', resolution: null, version: 1 });
      }
      if (fixture.unknown) {
        fixture.unknown = false;
        // End a response already acknowledged by Chromium, so its transport cannot
        // silently reconnect a reused socket before the app sees the lost body.
        response.setHeader('Content-Length', '1000');
        response.write('{"status":');
        await new Promise(resolve => setTimeout(resolve, 20));
        response.destroy(); return;
      }
      return reply(response, structuredClone(item));
    }
    if (path === '/api/staff/orders/delivery/yandex/config') return reply(response, { yandexEnabled: false });
    if (path === '/api/staff/orders/unread' || path === '/api/staff/orders/new-summary') return reply(response, { count: 0, latestOrderId: null });
    if (path === '/api/favorites' || path === '/api/categories') return reply(response, { items: [] });
    if (path === '/api/notifications') return reply(response, { scope: 'fixture-staff-7', events: [], hasMore: false });
    if (path === '/api/shop/settings') return reply(response, { deliveryEnabled: false, pickupEnabled: true, minDeliverySubtotal: 0 });
    if (path === '/api/staff/orders/128/coordination') return reply(response, { issues: fixture.issues,
      unread: 0, readThrough: 0, notifications: [], responseMinutes: 10, smsAvailable: false });
    throw new Error('Unexpected fixture endpoint: ' + request.method + ' ' + path);
  } catch (error) {
    report.fixtureErrors.push(error.message);
    if (!response.destroyed && !response.writableEnded) reply(response, { message: 'Fixture failure' }, 500);
  }
});

let web, browser;
try {
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  web = await startWeb(`http://127.0.0.1:${api.address().port}/api`);
  browser = await chromium.launch({ executablePath: process.env.CATALOG_BROWSER_PATH ??
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  for (const width of [320, 390, 1280]) {
    resetFixture();
    const context = await browser.newContext({ viewport: { width, height: 1000 }, isMobile: width < 600, hasTouch: width < 600 });
    await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('console', message => {
      if (/hydration|mismatch/i.test(message.text()) && !message.text().includes('net::ERR_CONTENT_LENGTH_MISMATCH'))
        report.errors.push(message.text());
    });
    const check = name => report.checks.push({ width, name });
    let gate;
    try {
      await page.goto(web.base + '/staff/orders/128?weigh=10#assembly', { waitUntil: 'networkidle' });
      await expect(page.getByRole('heading', { name: 'Помидоры розовые', exact: true })).toBeVisible();
      const save = page.getByRole('button', { name: 'Сохранить → следующая', exact: true });
      await expect(save).toBeDisabled();
      await page.locator('#weigh-quantity').fill('782');
      await expect(save).toBeEnabled();
      await expect(page.locator('.weigh__quote')).toContainText(/250,24\s*₽/);
      await expect(page.locator('.weigh__quote')).toContainText('+32 г');
      await expect(page.locator('.weigh__quote')).toContainText(/\+10,24\s*₽/);
      assert.equal(fixture.mutations.length, 0);
      check('read-only quote shows exact grams and acknowledged price without an item mutation');

      gate = Promise.withResolvers(); fixture.mutationGate = gate;
      const mutationSeen = page.waitForRequest(request => request.method() === 'PATCH');
      await save.click(); await mutationSeen;
      await expect(save).toBeDisabled(); await save.evaluate(button => button.click());
      assert.equal(fixture.mutations.length, 1, 'Busy submit cannot create another item write');
      gate.resolve();
      await expect(page.getByRole('heading', { name: 'Рыба целиком', exact: true })).toBeVisible();
      await expect(page.locator('.weigh__piece input')).toHaveCount(2);
      await expect(page.locator('.weigh__receipt')).toContainText(/Помидоры розовые.*782 г.*250,24\s*₽/);
      check('one save opens the next pending item and initializes each whole-weight input');

      await page.locator('#weigh-piece-0').fill('700');
      await expect(save).toBeDisabled();
      await page.locator('#weigh-piece-1').fill('800');
      await expect(save).toBeEnabled();
      await expect(page.locator('.weigh__quote')).toContainText('общий вес 1,5 кг');
      await expect(page.locator('.weigh__quote')).toContainText(/975\s*₽/);
      assert.deepEqual(fixture.quotes.at(-1), { itemId: 11, status: 'PICKED', actualQty: 2, pieceWeights: [700, 800] });
      await save.click();
      await expect(page.getByRole('heading', { name: 'Вторая целая рыба', exact: true })).toBeVisible();
      await expect(page.locator('.weigh__piece input')).toHaveCount(2);
      await expect(page.locator('#weigh-piece-0')).toHaveValue('');
      await page.getByRole('button', { name: 'Пропустить', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Укроп', exact: true })).toBeVisible();
      await expect(page.locator('.weigh__receipt')).toContainText(/Рыба целиком.*2 шт\..*1,5 кг.*975\s*₽/);
      check('whole items send individual integer weights and retain the exact saved total in the receipt');

      await page.getByRole('button', { name: 'Исправить Рыба целиком', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Рыба целиком', exact: true })).toBeVisible();
      assert.equal(fixture.mutations.length, 2, 'Opening a saved receipt does not reset the item');
      await page.getByRole('button', { name: 'Исправить эту позицию', exact: true }).click();
      assert.equal(fixture.mutations.length, 2, 'Reset requires an explicit confirmation');
      await page.getByRole('button', { name: 'Вернуть в сборку', exact: true }).click();
      await expect(page.locator('.weigh__piece input')).toHaveCount(2);
      await expect(page.locator('#weigh-piece-0')).toHaveValue('');
      await expect(save).toBeDisabled();
      assert.equal(fixture.mutations.at(-1).status, 'PENDING');
      check('receipt correction is read-only until reset confirmation and requires fresh individual weights');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'No horizontal overflow');
      await page.screenshot({ path: join(artifacts, `staff-weigh-${width}.png`), fullPage: true });

      resetFixture();
      await page.goto('about:blank');
      await page.goto(web.base + '/staff/orders/128?weigh=10#assembly', { waitUntil: 'networkidle' });
      gate = Promise.withResolvers(); fixture.quoteGate = gate;
      const quoteSeen = page.waitForRequest(request => new URL(request.url()).pathname.endsWith('/10/quote'));
      await page.locator('#weigh-quantity').fill('1024'); await quoteSeen;
      await page.getByRole('button', { name: 'Пропустить', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Рыба целиком', exact: true })).toBeVisible();
      gate.resolve();
      await expect(page.locator('.weigh__piece input')).toHaveCount(2);
      await expect(save).toBeDisabled();
      await expect(page.locator('.weigh__quote')).not.toContainText(/327,68\s*₽/);
      assert.equal(fixture.mutations.length, 0);
      await page.getByRole('button', { name: 'Пропустить', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Вторая целая рыба', exact: true })).toBeVisible();
      await expect(page.locator('.weigh__piece input')).toHaveCount(2);
      await expect(page.locator('#weigh-piece-0')).toHaveValue('');
      await expect(save).toBeDisabled();
      check('a delayed quote cannot attach the previous item price to the newly focused whole item');

      resetFixture();
      await page.goto('about:blank');
      await page.goto(web.base + '/staff/orders/128?weigh=10#assembly', { waitUntil: 'networkidle' });
      gate = Promise.withResolvers(); fixture.quoteGate = gate;
      const oldQuantitySeen = page.waitForRequest(request => new URL(request.url()).pathname.endsWith('/10/quote'));
      await page.locator('#weigh-quantity').fill('1024'); await oldQuantitySeen;
      await page.locator('#weigh-quantity').fill('1100');
      await expect(page.locator('.weigh__quote')).toContainText(/352\s*₽/);
      gate.resolve();
      await expect(page.locator('.weigh__quote')).toContainText(/352\s*₽/);
      await expect(page.locator('.weigh__quote')).not.toContainText(/327,68\s*₽/);
      assert.equal(fixture.mutations.length, 0);
      check('a delayed quote for an older draft cannot replace the current quantity price');

      resetFixture();
      await page.goto('about:blank');
      await page.goto(web.base + '/staff/orders/128?weigh=10#assembly', { waitUntil: 'networkidle' });
      await page.locator('#weigh-quantity').fill('1024'); await expect(save).toBeEnabled();
      fixture.unknown = true;
      await save.click();
      await expect(page.getByRole('button', { name: 'Исправить эту позицию', exact: true })).toBeVisible();
      await expect(page.locator('.weigh__state')).toContainText(/1,024 кг.*327,68\s*₽/);
      assert.equal(fixture.mutations.length, 1, 'A lost response never replays the committed mutation');
      await page.waitForTimeout(300);
      assert.equal(fixture.mutations.length, 1);
      check('unknown network outcome refreshes authoritative item state without replaying the write');

      resetFixture();
      await page.goto('about:blank');
      await page.goto(web.base + '/staff/orders/128?weigh=10#assembly', { waitUntil: 'networkidle' });
      await page.locator('#weigh-quantity').fill('1024'); await expect(save).toBeEnabled();
      fixture.unknown = true; fixture.readFailure = true;
      await save.click();
      await expect(page.getByRole('button', { name: 'Обновить заказ', exact: true })).toBeEnabled();
      await expect(page.getByRole('heading', { name: 'Помидоры розовые', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Товара нет', exact: true })).toBeDisabled();
      await expect(save).toBeDisabled();
      assert.equal(fixture.mutations.length, 1, 'Failed recovery keeps further writes blocked');
      await expect(page.getByText('Не удалось получить ответ сервера. Проверьте подключение к интернету. Обновите заказ перед повторным действием.', { exact: true })).toBeVisible();
      await page.screenshot({ path: join(artifacts, `staff-weigh-recovery-${width}.png`), fullPage: true });
      fixture.readFailure = false;
      await page.getByRole('button', { name: 'Обновить заказ', exact: true }).click();
      await expect(page.locator('.weigh__state')).toContainText(/1,024 кг.*327,68\s*₽/);
      await expect(page.getByRole('button', { name: 'Исправить эту позицию', exact: true })).toBeEnabled();
      assert.equal(fixture.mutations.length, 1);
      check('lost save and failed recovery preserve the visible order and block writes until an explicit successful refresh');

      resetFixture();
      await page.goto('about:blank');
      await page.goto(web.base + '/staff/orders/128?weigh=10#assembly', { waitUntil: 'networkidle' });
      await page.locator('#weigh-quantity').fill('1024'); await expect(save).toBeEnabled();
      await expect(page.locator('.weigh__quote')).toContainText('потребуется согласование покупателя');
      await save.click();
      await expect(page.getByRole('heading', { name: 'Рыба целиком', exact: true })).toBeVisible();
      await expect(page.locator('.weigh__attention')).toContainText(/Ждём покупателя:\s*2/);
      check('saving an out-of-tolerance weight creates a buyer decision and keeps assembly open');
      await page.getByRole('button', { name: 'Товара нет', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Вторая целая рыба', exact: true })).toBeVisible();
      await expect(page.locator('.weigh__receipt')).toContainText('Нет в наличии: Рыба целиком.');
      assert.deepEqual(fixture.mutations.at(-1), { itemId: 11, status: 'MISSING' });
      check('missing goods create a buyer question and a receipt, then open the next pending item');
      await page.getByRole('button', { name: 'Товара нет', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Укроп', exact: true })).toBeVisible();
      await expect(save).toBeEnabled(); await save.click();
      await expect(page.getByRole('link', { name: 'Проверить сборку в заказе', exact: true })).toBeVisible();
      assert.equal(fixture.items.find(item => item.id === 13).status, 'PENDING');
      assert.equal(fixture.mutations.length, 4);
      check('the final handled item never completes assembly or opens a pending item awaiting the buyer');

      for (const locked of [{ payment: { status: 'PAID' } }, { assemblyFinalizedAt: '2026-10-22T10:00:00Z' }]) {
        resetFixture(); fixture.orderChanges = locked;
        await page.goto('about:blank');
        await page.goto(web.base + '/staff/orders/128?weigh=10#assembly', { waitUntil: 'networkidle' });
        await expect(page.getByRole('heading', { name: 'Помидоры розовые', exact: true })).toBeVisible();
        await expect(page.locator('#weigh-quantity')).toHaveCount(0);
        await expect(save).toHaveCount(0);
        assert.equal(fixture.quotes.length, 0); assert.equal(fixture.mutations.length, 0);
        check('paid or finalized assembly cannot quote or save compact weighing: ' + Object.keys(locked)[0]);
      }

      resetFixture();
      await page.goto('about:blank');
      fixture.items.find(item => item.id === 10).status = 'MISSING';
      fixture.issues.push({ id: 110, orderItemId: 10, replacementItemId: 11,
        status: 'RESOLVED', type: 'MISSING_ITEM', resolution: 'ACCEPT_REPLACEMENT', version: 2 });
      await page.goto(web.base + '/staff/orders/128?weigh=11#assembly', { waitUntil: 'networkidle' });
      await expect(page.getByRole('heading', { name: 'Рыба целиком', exact: true })).toBeVisible();
      await expect(page.locator('.weigh__attention')).toContainText(/Нужно вам:\s*1/);
      Object.assign(fixture.items.find(item => item.id === 11), { status: 'PICKED', actualQty: 2,
        actualWeightGrams: 1500, pieceWeights: [700, 800], actualTotal: 97500 });
      await page.getByRole('button', { name: 'Обновить заказ', exact: true }).click();
      await expect(page.locator('.weigh__attention')).toContainText(/Нужно вам:\s*0/);
      assert.equal(fixture.mutations.length, 0, 'Refreshing accepted-replacement work is read-only');
      check('accepted replacement needs seller attention only while the replacement item remains pending');
    } finally { gate?.resolve(); fixture.quoteGate?.resolve(); fixture.mutationGate?.resolve(); await context.close(); }
  }
  assert.deepEqual(report.errors, []); assert.deepEqual(report.fixtureErrors, []);
  console.log(`PASS: staff-weigh ${report.checks.length} checks at 320/390/1280; exact quote, one save, next, whole weights, receipt/reset, stale and unknown results.`);
} finally {
  report.finalFixture = { quotes: fixture.quotes, mutations: fixture.mutations, reads: fixture.reads };
  await writeFile(join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
  console.log('Artifacts: ' + artifacts);
  await browser?.close(); await web?.close(); api.closeAllConnections();
  await new Promise(resolve => api.close(resolve));
}
