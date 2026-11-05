// Local browser verification. All API and map responses are synthetic; no courier is booked.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const web = fileURLToPath(new URL('../', import.meta.url));
const output = new URL('../../../work/delivery-estimate/', import.meta.url);
await mkdir(output, { recursive: true });
console.log('Starting local delivery smoke test.');
const addresses = [
  { id: 1, label: 'Дом', city: 'Москва', street: 'Барклая', house: '10', flat: '25', isDefault: true },
  { id: 2, label: 'Работа', city: 'Москва', street: 'Тверская', house: '11', flat: null, isDefault: false },
];
const estimateRequests = [];
const product = { id: 1, name: 'Тестовые яблоки', slug: 'test-apples', unit: 'GRAM', priceUnit: 'GRAM',
  saleModel: 'WEIGHT_LOOSE', priceStatus: 'SOURCE', price: 10000, priceQty: 1000,
  min: 500, step: 100, portionQty: 500, images: [], category: { name: 'Тестовые фрукты', slug: 'test-fruit' } };
let failEstimates = false;
const server = createServer(async (request, response) => {
  response.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:3119');
  response.setHeader('Access-Control-Allow-Credentials', 'true');
  response.setHeader('Access-Control-Allow-Headers', 'content-type');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  response.setHeader('Content-Type', 'application/json');
  if (request.method === 'OPTIONS') { response.end(); return; }
  const path = new URL(request.url, 'http://localhost').pathname.replace(/^\/api/, '');
  let data = [];
  if (path === '/auth/me') data = request.headers.cookie?.includes('test-user=1')
    ? { id: 1, role: 'USER', name: 'Тестовый покупатель', phone: '+79990000001', telegram: null } : null;
  if (path === '/auth/logout') response.setHeader('Set-Cookie', 'test-user=; Path=/; Max-Age=0; HttpOnly');
  if (path === '/addresses') data = addresses;
  if (path === '/delivery/estimate') {
    let body = '';
    for await (const chunk of request) body += chunk;
    const address = JSON.parse(body);
    estimateRequests.push(address);
    if (failEstimates) { response.statusCode = 502; data = { message: 'Synthetic provider failure' }; }
    else data = { price: address.house === '11' ? 70_001 : 65_001, currency: 'RUB',
      calculatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 120_000).toISOString(), sampleWeightGrams: 5_000 };
  }
  if (path === '/products' || path === '/favorites') data = { items: [], total: 0, page: 1, pages: 0, limit: 24 };
  if (path === '/home/slides') data = { slides: [], serverNow: new Date().toISOString(), validUntil: new Date(Date.now() + 60_000).toISOString() };
  if (path === '/shop/settings') data = { minDeliverySubtotal: 0, deliveryEnabled: true, pickupEnabled: true, freeDeliveryEnabled: false, freeDeliveryThreshold: null };
  if (path === '/cart') data = { items: [], products: [], subtotal: 0, goodsTotal: 0, revision: '1', valid: true, error: null, token: 'test', delivery: { eligible: false, price: null } };
  if (path === '/orders/quote') data = { items: [{ productId: 1, qty: 500, product, lineTotal: 5000, status: 'AVAILABLE' }],
    subtotal: 5000, goodsTotal: 5000, valid: true, error: null, token: 'test', delivery: { eligible: false, price: null } };
  if (path === '/order-phones') data = { phones: [], primaryPhone: '+79990000001' };
  if (path.endsWith('/summary')) data = { count: 0, unreadMessages: 0 };
  if (path === '/orders/queue/offer') data = { slots: [], preorderRequired: false };
  response.end(JSON.stringify(data));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
console.log('Synthetic API ready.');
const api = `http://127.0.0.1:${server.address().port}/api`;
let logs = '';
const child = spawn(process.execPath, [fileURLToPath(new URL('../.output/server/index.mjs', import.meta.url))], {
  cwd: web, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PORT: '3119', HOST: '127.0.0.1', NITRO_PORT: '3119', NITRO_HOST: '127.0.0.1', NITRO_UNIX_SOCKET: '', NUXT_PUBLIC_API_BASE: api,
    NUXT_PUBLIC_YANDEX_MAPS_KEY: 'synthetic-test-key', NUXT_TELEMETRY_DISABLED: '1' },
});
const log = chunk => { logs += chunk; appendFileSync(new URL('nuxt.log', output), chunk); };
child.stdout.on('data', log);
child.stderr.on('data', log);
let browser;
try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) throw new Error('Nuxt exited: ' + logs.slice(-5000));
    try {
      const response = await fetch('http://127.0.0.1:3119/delivery', { signal: AbortSignal.timeout(3000) });
      if (response.ok) { ready = true; break; }
    } catch { /* Wait for the local development server. */ }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.ok(ready, 'Local Nuxt server starts');
  console.log('Local production preview ready; starting browser checks.');
  browser = await chromium.launch({ headless: true, executablePath: process.env.CATALOG_BROWSER_PATH
    ?? (process.platform === 'win32' ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : undefined) });
  const errors = [];
  for (const width of [320, 390, 1280]) {
    console.log('Guest viewport: ' + width);
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://api-maps.yandex.ru/**', route => route.fulfill({
      contentType: 'application/javascript', body: `
      window.deliveryMaps = [];
      window.geocodeCalls = [];
      const makeAddress = (query = 'Москва, Барклая, д. 10к2') => {
        const street = query.includes('Тверская') ? 'Тверская' : query.includes('Пионерская') ? 'Пионерская' : 'Барклая';
        const house = /д\\.\\s*(\\d+)/.exec(query)?.[1] ?? '';
        return {
          geometry: { getCoordinates: () => [55.75 + Number(house) / 10000, 37.6] },
          properties: { get: () => 'exact' }, getLocalities: () => ['Москва'],
          getAdministrativeAreas: () => [], getThoroughfare: () => street, getPremiseNumber: () => house + (query.includes('к2') ? 'к2' : '')
        };
      };
      window.ymaps = {
        ready: ok => ok(),
        Map: class {
          events = { add: (name, fn) => { this.click = fn; } };
          geoObjects = { add: marker => { this.element.dataset.marker = JSON.stringify(marker.coordinates); },
            remove: () => { delete this.element.dataset.marker; } };
          searchEvents = {};
          results = [];
          controls = { get: () => ({
            events: { add: (name, fn) => { this.searchEvents[name] = fn; } },
            getResultsArray: () => this.results, getResult: async index => this.results[index]
          }) };
          constructor(element) {
            this.element = element;
            window.deliveryMaps.push(this);
            const form = document.createElement('form');
            const input = document.createElement('input'); input.setAttribute('aria-label', 'Поиск по карте');
            const find = document.createElement('button'); find.type = 'submit'; find.textContent = 'Найти на карте';
            const search = () => {
              this.searchEvents.submit?.();
              this.results = [makeAddress(input.value)];
              this.searchEvents.resultselect?.({ get: () => 0 });
            };
            input.onkeydown = event => { if (event.key === 'Enter') search(); };
            form.onsubmit = event => { event.preventDefault(); search(); };
            form.append(input, find);
            const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Тестовый дом на карте';
            button.onclick = () => this.click({ get: () => [55.751, 37.6] }); element.append(form, button);
          }
          setCenter(coordinates, zoom) { this.element.dataset.center = JSON.stringify({ coordinates, zoom }); return Promise.resolve(); }
          destroy() { this.element.replaceChildren(); }
        },
        Placemark: class {
          constructor(coordinates) { this.coordinates = coordinates; }
          geometry = { setCoordinates: coordinates => { this.coordinates = coordinates; } };
        },
        geocode: (query, options) => {
          window.geocodeCalls.push({ query, options });
          return Promise.resolve({ geoObjects: { get: () => makeAddress(typeof query === 'string' ? query : undefined) } });
        }
      };`,
    }));
    await page.goto('http://127.0.0.1:3119/delivery');
    await page.waitForFunction(() => document.querySelector('#__nuxt')?.__vue_app__?.config.globalProperties.$nuxt?.isHydrating === false);
    await page.getByRole('heading', { level: 1 }).waitFor();
    assert.equal(estimateRequests.length, 0, 'Guest is not estimated before choosing an address');
    const calculator = page.locator('section.calculator').first();
    await calculator.getByLabel('Улица', { exact: true }).fill('Барклая');
    await calculator.getByLabel('Дом', { exact: true }).fill('10');
    await calculator.getByRole('button', { name: 'Рассчитать доставку' }).click();
    await calculator.getByText('Доставка ≈ 650,01 ₽', { exact: true }).waitFor();
    assert.match(await page.locator('.delivery-bar__button').innerText(), /650,01/);
    await calculator.getByRole('button', { name: 'Выбрать на карте' }).click();
    const canvas = calculator.locator('.delivery-map__canvas');
    await expect(canvas).toHaveAttribute('data-marker', JSON.stringify([55.751, 37.6]));
    await calculator.getByLabel('Дом', { exact: true }).fill('11');
    await expect(canvas).toHaveAttribute('data-marker', JSON.stringify([55.7511, 37.6]));
    await expect(calculator.getByLabel('Дом', { exact: true })).toHaveValue('11');
    const search = calculator.getByRole('textbox', { name: 'Поиск по карте' });
    await search.fill('Пионерская');
    await search.press('Enter');
    await expect(calculator.locator('.delivery-map [role="status"]')).toContainText('Уточните номер дома');
    await expect(calculator.locator('.delivery-map__error')).toHaveCount(0);
    await expect(calculator.getByLabel('Дом', { exact: true })).toHaveValue('11');
    await search.fill('Москва, Тверская, д. 11');
    await calculator.getByRole('button', { name: 'Найти на карте' }).click();
    await expect(calculator.getByLabel('Улица', { exact: true })).toHaveValue('Тверская');
    await calculator.getByText('Доставка ≈ 700,01 ₽', { exact: true }).waitFor();
    await calculator.getByRole('button', { name: 'Выбрать на карте' }).click();
    await page.getByRole('button', { name: 'Тестовый дом на карте' }).click();
    await expect(calculator.getByLabel('Дом', { exact: true })).toHaveValue('10');
    await expect(calculator.getByLabel('Корпус / строение')).toHaveValue('к2');
    await calculator.getByLabel('Квартира / офис').fill('25');
    await calculator.getByLabel('Подъезд').fill('2');
    await calculator.getByLabel('Этаж').fill('7');
    await calculator.getByLabel('Домофон').fill('25К');
    await calculator.getByText(/кв\. 25/).waitFor();
    await calculator.getByText('Доставка ≈ 650,01 ₽', { exact: true }).waitFor();
    await page.screenshot({ path: fileURLToPath(new URL(`guest-${width}.png`, output)), fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No horizontal overflow');
    await page.locator('.delivery-bar__button').click();
    await page.getByRole('dialog').getByText('Доставка ≈ 650,01 ₽', { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await calculator.getByRole('link', { name: 'Выбрать продукты' }).click();
    await page.waitForURL('**/catalog');
    assert.match(await page.locator('.delivery-bar__button').innerText(), /650,01/);
    await page.evaluate(product => localStorage.setItem('cart', JSON.stringify({ version: 1, items: [{ product, qty: 500 }] })), product);
    await page.goto('http://127.0.0.1:3119/cart');
    const checkout = page.locator('.checkout');
    await checkout.getByRole('button', { name: 'Выбрать адрес на карте' }).click();
    const checkoutCanvas = checkout.locator('.delivery-map__canvas');
    const checkoutSearch = checkout.getByRole('textbox', { name: 'Поиск по карте' });
    await expect(checkoutSearch).toBeVisible();
    await expect(checkout.locator('[aria-invalid="true"]')).toHaveCount(0);
    await checkoutSearch.fill('Пионерская');
    await checkoutSearch.press('Enter');
    await expect(checkout.locator('.delivery-map [role="status"]')).toContainText('Уточните номер дома');
    await expect(checkout.locator('[aria-invalid="true"]')).toHaveCount(0);
    await checkoutSearch.fill('Москва, Тверская, д. 11');
    await checkout.getByRole('button', { name: 'Найти на карте' }).click();
    await expect(checkout.locator('[data-checkout-field="street"] input')).toHaveValue('Тверская');
    await expect(checkout.locator('[data-checkout-field="house"] input')).toHaveValue('11');
    await expect(checkout.locator('[aria-invalid="true"]')).toHaveCount(0);
    await checkout.getByRole('button', { name: 'Выбрать адрес на карте' }).click();
    await checkout.locator('[data-checkout-field="house"] input').fill('12');
    await expect(checkoutCanvas).toHaveAttribute('data-marker', JSON.stringify([55.7512, 37.6]));
    await checkout.getByLabel('Квартира', { exact: true }).fill('25');
    await checkout.getByRole('button', { name: 'Тестовый дом на карте' }).click();
    await expect(checkout.getByLabel('Квартира', { exact: true })).toHaveValue('');
    await checkout.getByLabel('Квартира', { exact: true }).fill('25');
    await checkout.getByRole('button', { name: 'Выбрать адрес на карте' }).click();
    await checkout.getByRole('button', { name: 'Другому человеку' }).click();
    await expect(checkoutCanvas).not.toHaveAttribute('data-marker');
    await checkout.getByRole('button', { name: 'Для себя', exact: true }).click();
    await expect(checkoutCanvas).toHaveAttribute('data-marker', JSON.stringify([55.751, 37.6]));
    await checkout.getByRole('button', { name: 'Скрыть карту' }).click();
    await checkout.getByRole('button', { name: 'Выбрать адрес на карте' }).click();
    await expect(checkoutCanvas).toHaveAttribute('data-marker', JSON.stringify([55.751, 37.6]));
    await page.screenshot({ path: fileURLToPath(new URL('checkout-map-' + width + '.png', output)), fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Checkout has no horizontal overflow');
    await checkout.locator('.summary__submit').getByRole('button', { name: 'Оформить заказ', exact: true }).click();
    await expect(checkout.locator('[data-checkout-field="name"] input')).toHaveAttribute('aria-invalid', 'true');
    await expect(checkout.locator('[data-checkout-field="name"] [data-slot="error"]')).toBeVisible();
    await context.close();
    estimateRequests.length = 0;
  }
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  console.log('Checking saved addresses, errors and logout.');
  await context.addCookies([{ name: 'test-user', value: '1', url: 'http://127.0.0.1' }]);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:3119/delivery');
  await page.locator('.delivery-bar__price').getByText('Доставка ≈ 650,01 ₽', { exact: true }).waitFor();
  const calculator = page.locator('section.calculator').first();
  await calculator.getByRole('button', { name: /Работа/ }).click();
  await calculator.getByText('Доставка ≈ 700,01 ₽', { exact: true }).waitFor();
  await page.reload();
  await page.locator('.delivery-bar__price').getByText('Доставка ≈ 700,01 ₽', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('delivery-address:1')), '2');
  await page.goto('http://127.0.0.1:3119/cart');
  // A full reload on the cart must restore the selected address for the header.
  await page.waitForFunction(() => document.querySelector('.delivery-bar__button')?.textContent.includes('Тверская'));
  assert.match(await page.locator('.delivery-bar__button').innerText(), /Тверская/);
  await page.goto('http://127.0.0.1:3119/delivery');
  await page.locator('.delivery-bar__price').getByText('Доставка ≈ 700,01 ₽', { exact: true }).waitFor();
  failEstimates = true;
  await page.locator('section.calculator').getByLabel('Дом', { exact: true }).fill('12');
  await page.getByRole('button', { name: 'Рассчитать доставку' }).click();
  await page.getByText('Не удалось обновить стоимость. Проверьте адрес или повторите позже.', { exact: true }).waitFor();
  assert.doesNotMatch(await page.locator('.delivery-bar__button').innerText(), /700,01/);
  failEstimates = false;
  await page.getByRole('button', { name: 'Повторить расчёт', exact: true }).click();
  await page.locator('.estimate__price').getByText('Доставка ≈ 650,01 ₽', { exact: true }).waitFor();
  await page.goto('http://127.0.0.1:3119/profile');
  await page.waitForFunction(() => document.querySelector('#__nuxt')?.__vue_app__?.config.globalProperties.$nuxt?.isHydrating === false);
  await page.getByRole('button', { name: 'Выйти', exact: true }).click();
  await page.waitForURL('http://127.0.0.1:3119/');
  await page.locator('.delivery-bar__address').getByText('Укажите адрес доставки', { exact: true }).waitFor();
  assert.deepEqual(errors, [], 'No browser exceptions');
  console.log('PASS: 320/390/1280px, manual map sync, street/house search, Enter isolation, recipient switching, map reopening, modal, saved addresses, error/retry and logout.');
  console.log('Screenshots: ' + fileURLToPath(output));
} catch (error) {
  for (const [contextIndex, context] of (browser?.contexts() ?? []).entries()) {
    for (const [pageIndex, page] of context.pages().entries()) {
      const name = `failure-${contextIndex}-${pageIndex}`;
      await page.screenshot({ path: fileURLToPath(new URL(name + '.png', output)), fullPage: true }).catch(() => {});
      await writeFile(new URL(name + '.html', output), await page.content().catch(() => 'Page unavailable'));
    }
  }
  throw error;
} finally {
  await browser?.close();
  child.kill();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await writeFile(new URL('nuxt.log', output), logs);
}
