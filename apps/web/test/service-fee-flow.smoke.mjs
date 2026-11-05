import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { serviceFeeApi } from './fixtures/service-fee-api.mjs';
import { startWeb } from './browser.mjs';

const artifacts = await mkdtemp(join(tmpdir(), 'korzina-fee-flow-'));
let api, web, browser;
const checks = [], errors = [];
try {
  api = await serviceFeeApi();
  const call = async (path, body, actor = 'ADMIN', method = body ? 'POST' : 'GET') => {
    const response = await fetch(api.apiBase + path, { method,
      headers: { 'Content-Type': 'application/json', Cookie: api.cookieName + '=' + actor },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const global = async percent => assert.equal((await call('/admin/settings', { globalServiceMarkupPercent: percent }, 'ADMIN', 'PATCH')).status, 200);
  const product = async override => {
    const response = await call('/admin/products', { name: 'Flow product ' + String(override), slug: 'flow-' + randomUUID(),
      description: null, price: 10000, priceQty: 1, unit: 'PIECE', min: 1, step: 1, portionQty: 1,
      categoryId: api.categoryId, active: true, sort: 0, serviceMarkupPercentOverride: override });
    assert.equal(response.status, 201); return response.body;
  };
  const apply = async id => {
    const preview = await call('/admin/products/service-fee/bulk/preview', { mode: 'global', selection: { kind: 'ids', ids: [id] } });
    assert.equal(preview.status, 201);
    const body = { previewToken: preview.body.previewToken, requestId: randomUUID(), confirmed: true };
    const result = await call('/admin/products/service-fee/bulk/apply', body); assert.equal(result.status, 201);
    const state = async () => ({ product: await api.db.product.findUniqueOrThrow({ where: { id } }),
      audits: await api.db.adminAudit.findMany({ orderBy: { id: 'asc' } }), events: await api.db.adminChange.findMany({ orderBy: { id: 'asc' } }) });
    const committed = await state();
    assert.deepEqual((await call('/admin/products/service-fee/bulk/apply', body)).body, result.body);
    assert.deepEqual(await state(), committed);
    assert.equal((await call('/admin/products/service-fee/bulk/apply', body, 'OTHER_ADMIN')).status, 403);
    return preview.body;
  };
  await global(15);
  const inherited = await product(null), zero = await product(0);
  assert.equal(inherited.customerPrice, 11500); assert.equal(zero.customerPrice, 10000);
  assert.equal((await api.db.product.findUniqueOrThrow({ where: { id: 1 } })).serviceMarkupPercentOverride, 10);
  const preview = await apply(1); assert.equal(preview.rows[0].before.percent, 10); assert.equal(preview.rows[0].after.percent, 15);
  assert.equal((await call('/admin/settings', { globalServiceMarkupPercent: 20 }, 'OTHER_ADMIN', 'PATCH')).status, 403);
  checks.push('global15/new global/individual0/legacy10/bulk/events/durable replay/primary-delegated guards');

  await api.db.shopSettings.update({ where: { id: 1 }, data: { minDeliverySubtotal: 0 } });
  await api.db.shopHours.updateMany({ data: { enabled: true, openMinutes: 0, closeMinutes: 1440 } });
  let cart = await api.cart.get(api.buyerId);
  for (const id of [inherited.id, zero.id, 1]) cart = await api.cart.change(api.buyerId, cart.revision, { kind: 'set', productId: id, qty: 1 });
  assert.equal(cart.subtotal, 33000);
  const order = (await api.cart.checkout(api.buyerId, cart.revision, { type: 'PICKUP', customerName: 'Unified flow buyer',
    customerPhone: '+79990000123', checkoutRequestId: randomUUID() })).order;
  const items = await api.db.orderItem.findMany({ where: { orderId: order.id } });
  assert.deepEqual(items.map(item => [item.productId, item.price, item.serviceMarkupPercentSnapshot]).sort((a,b)=>a[0]-b[0]),
    [[1,11500,15],[inherited.id,11500,15],[zero.id,10000,0]]);
  const snapshot = await api.db.order.findUniqueOrThrow({ where: { id: order.id }, include: { items: true } });
  assert.equal(snapshot.userId, api.buyerId);
  await global(10);
  const same = await apply(2); assert.equal(same.rows[0].difference, 0); assert.equal(same.rows[0].changed, true);
  const mode = await api.db.adminChange.findFirstOrThrow({ where: { entity: 'Product', productId: 2 }, orderBy: { id: 'desc' } });
  assert.equal(mode.beforeValue.serviceMarkupPercentOverride, 10); assert.equal(mode.afterValue.serviceMarkupPercentOverride, null);
  assert.equal(mode.ownerOnly, true); assert.equal(mode.actorId, api.adminId);
  assert.deepEqual(await api.db.order.findUniqueOrThrow({ where: { id: order.id }, include: { items: true } }), snapshot);
  assert.deepEqual(await api.history(), { orders: [...api.historical.orders, ...(await api.db.order.findMany({where:{id:order.id}}))],
    items: [...api.historical.items, ...(await api.db.orderItem.findMany({where:{orderId:order.id}}))], payments: api.historical.payments });
  checks.push('unified buyer cart33000/checkout snapshots15-0-15/history immutable/individual10-global10 event');

  web = await startWeb(api.apiBase);
  browser = await chromium.launch({ executablePath: process.env.CATALOG_BROWSER_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  for (const width of [320,768,1280]) {
    const context = await browser.newContext({ viewport: {width,height:1000} });
    await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    await context.addCookies([{ name:api.cookieName,value:'ADMIN',url:web.base,httpOnly:true }]);
    const page = await context.newPage(); page.on('pageerror',error=>errors.push(error.message));
    await page.goto(web.base+'/admin/events', {waitUntil:'networkidle'});
    await expect(page.getByText('Режим сервисного процента',{exact:true}).first()).toBeVisible();
    await expect(page.getByText('Индивидуальный (10%)',{exact:true}).first()).toBeVisible();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await page.screenshot({path:join(artifacts,'events-'+width+'.png'),fullPage:true});
    await context.addCookies([{name:api.cookieName,value:'OTHER_ADMIN',url:web.base,httpOnly:true}]);
    await page.goto(web.base+'/admin/settings',{waitUntil:'networkidle'});
    assert.equal(await page.getByLabel('Глобальный процент, %',{exact:true}).count(),0);
    await page.goto(web.base+'/admin/products',{waitUntil:'networkidle'});
    assert.equal(await page.getByLabel(/^Выбрать процент для/).count(),0);
    assert.equal(await page.getByRole('heading',{name:'Массовое управление сервисным вознаграждением',exact:true}).count(),0);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await page.screenshot({path:join(artifacts,'delegated-'+width+'.png'),fullPage:true});
    await context.close(); checks.push('real PostgreSQL-backed Event Center and delegated controls at '+width);
  }
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({status:'passed',artifacts,checks},null,2));
} finally {
  await browser?.close(); await web?.close(); await api?.close();
  await writeFile(join(artifacts,'report.json'),JSON.stringify({checks,errors},null,2));
}
