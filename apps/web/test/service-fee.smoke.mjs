import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { serviceFeeApi } from './fixtures/service-fee-api.mjs';
import { startWeb } from './browser.mjs';

const artifacts = await mkdtemp(join(tmpdir(), 'korzina-fee-browser-'));
let api, web, browser, page;
const errors = [], checks = [];
try {
  api = await serviceFeeApi();
  web = await startWeb(api.apiBase);
  browser = await chromium.launch({ executablePath: process.env.CATALOG_BROWSER_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  const identity = async value => context.addCookies([{ name: api.cookieName, value, url: web.base, httpOnly: true }]);
  await identity('ADMIN');
  page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (/hydration.*mismatch/i.test(message.text())) errors.push(message.text()); });
  const apiRequest = (path, body, role = 'ADMIN') => fetch(api.apiBase + path, { method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: api.cookieName + '=' + role }, body: JSON.stringify(body) });
  const saveProduct = async (id = 1) => {
    const [response] = await Promise.all([page.waitForResponse(r => r.url().endsWith('/admin/products/' + id) && r.request().method() === 'PATCH'), page.getByRole('button', { name: 'Сохранить изменения', exact: true }).click()]);
    assert.equal(response.status(), 200, await response.text());
  };
  const selectMode = async name => { await page.getByRole('combobox', { name: 'Режим сервисного вознаграждения', exact: true }).click(); await page.getByRole('option', { name, exact: true }).click(); };
  const noOverflow = async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No page horizontal overflow');
  await page.goto(web.base + '/admin/settings', { waitUntil: 'networkidle' });
  const panel = page.locator('form').filter({ has: page.getByLabel('Глобальный процент, %', { exact: true }) });
  const globalInput = page.getByLabel('Глобальный процент, %', { exact: true });
  await expect(globalInput).toHaveValue('10');
  await page.setViewportSize({ width: 320, height: 900 });
  for (const percent of [15,0,100,10]) {
    const previous = (await api.db.shopSettings.findUniqueOrThrow({ where: { id: 1 } })).globalServiceMarkupPercent;
    await globalInput.fill(String(percent)); await panel.getByRole('button', { name: 'Сохранить изменения', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Изменить общий процент?' }); await expect(dialog).toBeVisible();
    await noOverflow();
    if (percent === 15) { await page.waitForTimeout(300); await page.screenshot({ path: join(artifacts, 'confirm-global-320.png') }); }
    assert.equal((await api.db.shopSettings.findUniqueOrThrow({ where: { id: 1 } })).globalServiceMarkupPercent, previous);
    const [response] = await Promise.all([page.waitForResponse(r => r.url().endsWith('/admin/settings') && r.request().method() === 'PATCH'), dialog.getByRole('button', { name: 'Подтвердить изменение' }).click()]);
    assert.equal(response.status(), 200);
    await expect(panel).toContainText(`Текущий глобальный процент: ${percent}%`);
    assert.equal(await api.db.product.count({ where: { serviceMarkupPercentOverride: 10, serviceMarkupPercent: 10, serviceMarkupNeedsReview: true } }), 173);
  }
  checks.push('real settings API: global 10/15/0/100, confirmation, 173 preserved exceptions');
  await globalInput.fill('101'); assert.equal(await panel.getByRole('button', { name: 'Сохранить изменения' }).isDisabled(), true);
  await globalInput.fill('15');
  const release = await api.lockProduct();
  try {
    const before = api.requests.filter(r => r.path === '/api/admin/settings' && r.method === 'PATCH').length;
    await panel.getByRole('button', { name: 'Сохранить изменения' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Подтвердить изменение' }).click();
    await expect(panel).toContainText('Настройки сейчас обновляются или используются при оформлении заказа. Повторите попытку');
    await page.waitForTimeout(700);
    assert.equal(api.requests.filter(r => r.path === '/api/admin/settings' && r.method === 'PATCH').length, before + 1);
    assert.equal(api.requests.at(-1).status, 409);
  } finally { await release(); }
  checks.push('real Product lock produces 409; human message, one request, validation');
  for (const width of [320,768,1280]) { await page.setViewportSize({ width, height: 900 }); await noOverflow(); await page.screenshot({ path: join(artifacts, `settings-${width}.png`), fullPage: true }); }
  await page.goto(web.base + '/admin/products/1', { waitUntil: 'networkidle' });
  await expect(page.getByText('Процент перенесён из старой системы.', { exact: false })).toBeVisible();
  await expect(page.getByLabel('Индивидуальный процент, %', { exact: true })).toHaveValue('10');
  await saveProduct(); assert.equal((await api.db.product.findUniqueOrThrow({ where: { id: 1 } })).serviceMarkupNeedsReview, true);
  await page.setViewportSize({ width: 320, height: 900 });
  await selectMode('Общий процент');
  await expect(page.getByRole('dialog', { name: 'Перейти на общий процент?' })).toBeVisible();
  await noOverflow(); await page.waitForTimeout(300); await page.screenshot({ path: join(artifacts, 'confirm-product-320.png') });
  await page.getByRole('dialog').getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(page.getByLabel('Индивидуальный процент, %', { exact: true })).toHaveValue('10');
  await selectMode('Общий процент'); await page.getByRole('button', { name: 'Использовать общий процент', exact: true }).click();
  assert.equal(await page.getByLabel('Индивидуальный процент, %', { exact: true }).count(), 0);
  await expect(page.getByText('Эффективный процент: 10%', { exact: false })).toBeVisible();
  await saveProduct();
  assert.equal((await api.db.product.findUniqueOrThrow({ where: { id: 1 } })).serviceMarkupPercentOverride, null);
  assert.equal(await page.getByText('Процент перенесён из старой системы.', { exact: false }).count(), 0);
  assert.equal((await apiRequest('/admin/settings', { globalServiceMarkupPercent: 15 })).status, 200);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByText('Эффективный процент: 15%', { exact: false })).toBeVisible();
  await expect(page.locator('dl').first()).toContainText('115 ₽');
  await page.getByRole('button', { name: 'Обновить процент', exact: true }).click();
  checks.push('legacy review, cancel/confirm global, nullable override, global refresh and server price');
  await selectMode('Индивидуальный процент');
  for (const percent of [0,10,20]) {
    await page.getByLabel('Индивидуальный процент, %', { exact: true }).fill(String(percent));
    await expect(page.getByText(`Эффективный процент: ${percent}%`, { exact: false })).toBeVisible();
    await saveProduct();
    const product = await api.db.product.findUniqueOrThrow({ where: { id: 1 } });
    assert.equal(product.serviceMarkupPercentOverride, percent); assert.equal(product.serviceMarkupPercent, percent);
    await page.reload({ waitUntil: 'networkidle' }); await expect(page.getByLabel('Индивидуальный процент, %', { exact: true })).toHaveValue(String(percent));
  }
  for (const width of [320,768,1280]) {
    await page.setViewportSize({ width, height: 900 }); await noOverflow();
    await page.screenshot({ path: join(artifacts, `product-${width}.png`), fullPage: true });
  }
  checks.push('individual 0/10/20, repeated editing/reopening, responsive 320/768/1280');
  await page.goto(web.base + '/admin/products/new', { waitUntil: 'networkidle' });
  await expect(page.getByText('Глобальный процент: 15%', { exact: false })).toBeVisible();
  assert.equal(await page.getByLabel('Индивидуальный процент, %', { exact: true }).count(), 0);
  await page.locator('form input[maxlength="160"]').fill('Новый общий товар');
  await page.locator('form [role="combobox"]').first().click();
  await page.getByRole('option', { name: 'Сервисные проценты', exact: true }).click();
  await page.locator('form input[inputmode="decimal"]').first().fill('100');
  await expect(page.getByText('Эффективный процент: 15%', { exact: false })).toBeVisible();
  const [created] = await Promise.all([page.waitForResponse(r => r.url().endsWith('/admin/products') && r.request().method() === 'POST'), page.getByRole('button', { name: 'Создать товар', exact: true }).click()]);
  assert.equal(created.status(), 201, await created.text());
  const fresh = await created.json();
  assert.equal(fresh.serviceMarkupPercentOverride, null); assert.equal(fresh.serviceMarkupPercent, 15); assert.equal(fresh.customerPrice, 11500);
  await expect(page).toHaveURL(web.base + '/admin/products/' + fresh.id);
  checks.push('create with global mode, no duplicate fee, backend preview and saved price agree');
  await page.goto(web.base + '/admin/products', { waitUntil: 'networkidle' });
  await expect(page.getByText('Общий: 15%', { exact: true })).toBeVisible();
  assert.ok(await page.getByText('Требует проверки', { exact: true }).count() > 0);
  await page.setViewportSize({ width: 320, height: 900 }); await noOverflow();
  await page.screenshot({ path: join(artifacts, 'list-320.png'), fullPage: true });
  await page.locator('form input[maxlength="160"]').fill('Перенесённый товар 1');
  const [found] = await Promise.all([page.waitForResponse(r => new URL(r.url()).pathname === '/api/admin/products'), page.getByRole('button', { name: 'Найти', exact: true }).click()]);
  const foundPage = await found.json();
  await expect(page.getByRole('link', { name: foundPage.items[0].name, exact: true })).toBeVisible();
  for (let index = 2; index <= foundPage.pages; index++) {
    const [next] = await Promise.all([page.waitForResponse(r => new URL(r.url()).pathname === '/api/admin/products'), page.getByRole('button', { name: 'Далее', exact: true }).click()]);
    const nextPage = await next.json();
    await expect(page.getByRole('link', { name: nextPage.items[0].name, exact: true })).toBeVisible();
  }
  await expect(page.getByText('Индивидуальный: 20%', { exact: true })).toBeVisible();
  checks.push('paginated real list uses response mode/percent/review; no misleading local filter');
  await identity('OWNER');
  await page.goto(web.base + '/staff/products/1', { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: 'Редактировать свой товар' })).toBeVisible();
  assert.equal(await page.getByRole('combobox', { name: 'Режим сервисного вознаграждения' }).count(), 0);
  await noOverflow();
  const [ownerSaved] = await Promise.all([page.waitForResponse(r => r.url().endsWith('/owner/products/1') && r.request().method() === 'PATCH'), page.getByRole('button', { name: 'Сохранить изменения', exact: true }).click()]);
  assert.equal(ownerSaved.status(), 200, await ownerSaved.text());
  assert.equal((await api.db.product.findUniqueOrThrow({ where: { id: 1 } })).serviceMarkupPercentOverride, 20);
  for (const role of ['OWNER','SELLER']) {
    assert.equal((await apiRequest('/admin/settings', { globalServiceMarkupPercent: 100 }, role)).status, 403);
    assert.equal((await apiRequest('/admin/products/1', { serviceMarkupPercentOverride: 100 }, role)).status, 403);
  }
  assert.equal((await apiRequest('/admin/settings', { globalServiceMarkupPercent: 100 }, 'OTHER_ADMIN')).status, 403);
  await identity('OTHER_ADMIN'); await page.goto(web.base + '/admin/settings', { waitUntil: 'networkidle' });
  assert.equal(await page.getByLabel('Глобальный процент, %', { exact: true }).count(), 0);
  await page.goto(web.base + '/admin/products', { waitUntil: 'networkidle' });
  assert.equal(await page.getByRole('heading', { name: 'Массовое управление сервисным вознаграждением', exact: true }).count(), 0);
  assert.equal(await page.getByLabel(/^Выбрать процент для/).count(), 0);
  await identity('SELLER'); await page.goto(web.base + '/admin/settings', { waitUntil: 'networkidle' });
  assert.equal(await page.getByLabel('Глобальный процент, %', { exact: true }).count(), 0);
  checks.push('owner/seller access denied; delegated UI hides global/bulk and real backend rejects delegated global writes');
  assert.equal(await api.db.product.count({ where: { serviceMarkupPercentOverride: 10, serviceMarkupPercent: 10, serviceMarkupNeedsReview: true } }), 172);
  assert.deepEqual(await api.history(), api.historical);
  assert.ok((await api.db.adminAudit.count({ where: { actorId: api.adminId } })) > 0);
  for (const request of api.requests) {
    assert.ok(!Object.hasOwn(request.body ?? {}, 'serviceMarkupPercent'), JSON.stringify(request));
    assert.ok(!Object.hasOwn(request.body ?? {}, 'serviceMarkupNeedsReview'));
  }
  assert.deepEqual(errors, []);
  checks.push('historical order/item/payment unchanged; audit exists; no legacy writing fields or browser errors');
  console.log(JSON.stringify({ artifacts, checks, errors }, null, 2));
} finally {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: join(artifacts, 'last-page.png'), fullPage: true }).catch(() => {});
    await writeFile(join(artifacts, 'last-page.html'), await page.content());
  }
  await browser?.close(); await web?.close(); await api?.close();
  await writeFile(join(artifacts, 'report.json'), JSON.stringify({ checks, errors }, null, 2));
  console.log('Artifacts: ' + artifacts);
}
