// Local browser verification. All API and map responses are synthetic; no courier is booked.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const web = fileURLToPath(new URL('../', import.meta.url));
const output = new URL('../../../work/delivery-estimate/', import.meta.url);
await mkdir(output, { recursive: true });
console.log('Starting local delivery smoke test.');
const addresses = [
  { id: 1, label: 'Дом', city: 'Москва', street: 'Барклая', house: '10', flat: '25', isDefault: true },
  { id: 2, label: 'Работа', city: 'Москва', street: 'Тверская', house: '11', flat: null, isDefault: false },
];
const estimateRequests = [];
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
  for (const width of [390, 1280]) {
    console.log('Guest viewport: ' + width);
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://api-maps.yandex.ru/**', route => route.fulfill({
      contentType: 'application/javascript', body: `
      window.ymaps = {
        ready: ok => ok(),
        Map: class {
          events = { add: (name, fn) => { this.click = fn; } };
          geoObjects = { add() {} };
          controls = { get: () => ({ events: { add() {} } }) };
          constructor(element) {
            const button = document.createElement('button'); button.textContent = 'Тестовый дом на карте';
            button.onclick = () => this.click({ get: () => [55.75, 37.6] }); element.append(button);
          }
          setCenter() { return Promise.resolve(); } destroy() {}
        },
        Placemark: class { geometry = { setCoordinates() {} }; },
        geocode: () => Promise.resolve({ geoObjects: { get: () => ({
          geometry: { getCoordinates: () => [55.75, 37.6] }, getLocalities: () => ['Москва'],
          getAdministrativeAreas: () => [], getThoroughfare: () => 'Барклая', getPremiseNumber: () => '10к2'
        }) } })
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
    await page.getByRole('button', { name: 'Тестовый дом на карте' }).click();
    await calculator.getByLabel('Дом', { exact: true }).waitFor();
    assert.equal(await calculator.getByLabel('Дом', { exact: true }).inputValue(), '10');
    assert.equal(await calculator.getByLabel('Корпус / строение').inputValue(), 'к2');
    await calculator.getByLabel('Квартира / офис').fill('25');
    await calculator.getByLabel('Подъезд').fill('2');
    await calculator.getByLabel('Этаж').fill('7');
    await calculator.getByLabel('Домофон').fill('25К');
    await calculator.getByText('Доставка ≈ 650,01 ₽', { exact: true }).waitFor();
    await calculator.getByText(/кв\. 25/).waitFor();
    await page.screenshot({ path: fileURLToPath(new URL(`guest-${width}.png`, output)), fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No horizontal overflow');
    await page.locator('.delivery-bar__button').click();
    await page.getByRole('dialog').getByText('Доставка ≈ 650,01 ₽', { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await calculator.getByRole('link', { name: 'Выбрать продукты' }).click();
    await page.waitForURL('**/catalog');
    assert.match(await page.locator('.delivery-bar__button').innerText(), /650,01/);
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
  console.log('PASS: guest desktop/mobile, map selection, modal, navigation, automatic saved address, persistent selection, error/retry and logout.');
  console.log('Screenshots: ' + fileURLToPath(output));
} finally {
  await browser?.close();
  child.kill();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await writeFile(new URL('nuxt.log', output), logs);
}
