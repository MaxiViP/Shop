// Local fixture API and an isolated headless Chromium profile; no production requests/writes.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { startWeb, openBrowser } from './browser.mjs';
import { lineAmount } from '../app/utils/assembly.ts';
import { estimatedQuantity, saleExplanation } from '../app/utils/sale.ts';
import { photoOrigins } from '../../api/src/product/photo-origins.ts';
const artifacts = new URL(process.env.SALE_SMOKE_OUTPUT ?? '../../../docs/catalog-sale-audit/ui/', import.meta.url);
await mkdir(artifacts, { recursive: true });
const category = { id: 1, name: 'Продукты', slug: 'market' };
const baseProduct = { min: 1, step: 1, portionQty: 1, priceQty: 1, priceStatus: 'AUDITED', category, images: [], marketPoint: null, isSeasonal: false, isHit: false, seasonalStartsAt: null, seasonalEndsAt: null, description: null };
const illustrationSlug = 'cezoni-market-black-olives-350g';
const illustrationUrl = Object.entries(photoOrigins).find(([, slug]) => slug === illustrationSlug)?.[0];
assert.ok(illustrationUrl);
const illustrationBytes = await readFile(new URL(`../../api/data/product-photos/2026-10-18/pack/cezoni-market/${illustrationSlug}.webp`, import.meta.url));
const products = [
  { ...baseProduct, id: 1, name: 'Картофель', slug: 'loose', price: 11000, unit: 'GRAM', priceUnit: 'GRAM', saleModel: 'WEIGHT_LOOSE', priceQty: 1000, min: 500, step: 100, portionQty: 500 },
  { ...baseProduct, id: 2, name: 'Голубика в лотке 125 г', slug: 'pack', price: 22000, unit: 'PACK', priceUnit: 'PACK', saleModel: 'PACK' },
  { ...baseProduct, id: 3, name: 'Укроп', slug: 'bunch', price: 8800, unit: 'BUNCH', priceUnit: 'BUNCH', saleModel: 'BUNCH' },
  { ...baseProduct, id: 4, name: 'Говяжий отруб на кости', slug: 'whole', price: 165000, unit: 'PIECE', priceUnit: 'GRAM', saleModel: 'WHOLE_VARIABLE_WEIGHT', priceQty: 1000, wholeLabel: 'кусок' },
  { ...baseProduct, id: 5, name: 'Дорадо целая', slug: 'fish', price: 110000, unit: 'PIECE', priceUnit: 'GRAM', saleModel: 'WHOLE_VARIABLE_WEIGHT', priceQty: 1000, wholeLabel: 'рыба' },
  { ...baseProduct, id: 6, name: 'Филе с нарезкой по весу', slug: 'cut', price: 220000, unit: 'GRAM', priceUnit: 'GRAM', saleModel: 'CUT_TO_WEIGHT', priceQty: 1000, min: 500, step: 100, portionQty: 500 },
  { ...baseProduct, id: 7, name: 'Форель со штучной ценой', slug: 'piece', price: 5500, unit: 'PIECE', priceUnit: 'PIECE', saleModel: 'PIECE_FIXED' },
  { ...baseProduct, id: 8, name: 'Оливки чёрные в рассоле 350 г', slug: illustrationSlug, price: 23949, unit: 'PACK', priceUnit: 'PACK', saleModel: 'PACK', images: [{ url: illustrationUrl, alt: null }] },
];
const publicId = randomUUID();
let staffMode = false;
let created = null;
let picked = null;
const requests = [];
const staffOrder = () => ({ id: 707, publicId, status: 'ASSEMBLING', type: 'PICKUP', fulfillmentMode: 'ASAP', scheduledFor: null, queueRank: null,
  customerName: 'Тестовый покупатель', customerPhone: '+79990000000', items: [{ ...products[3], id: 7071, productId: 4, productName: products[3].name, productSlug: 'whole',
    qty: 2, actualQty: picked ? 2 : null, actualWeightGrams: picked ? 3200 : null, pieceWeights: picked ? [1700, 1500] : null, status: picked ? 'PICKED' : 'PENDING',
    total: null, actualTotal: picked ? 528000 : null, actualPrice: null, actualSellerPrice: null, serviceMarkupPercentSnapshot: 10, weightMinGrams: null, weightMaxGrams: null }],
  subtotal: null, total: null, deliveryPrice: 0, finalSubtotal: null, finalTotal: null, weightToleranceBps: 1000, assemblyFinalizedAt: null, assemblyStartedAt: new Date().toISOString(),
  cancellations: [], restoreProblem: null, issues: [], extras: [], payment: null, delivery: null, preparationMinutes: 15, createdAt: new Date().toISOString() });
const api = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === illustrationUrl) { res.setHeader('Content-Type', 'image/webp'); res.end(illustrationBytes); return; }
  res.setHeader('Content-Type', 'application/json');
  if (req.headers.origin && /^http:\/\/127\.0\.0\.1:\d+$/.test(req.headers.origin)) {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin); res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'content-type'); res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  }
  if (req.method === 'OPTIONS') { res.end(); return; }
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
  requests.push({ path: url.pathname, method: req.method, body: input });
  let body = {};
  if (url.pathname === '/api/auth/me') body = staffMode ? { id: 900, role: 'SELLER', name: 'Сборщик', phone: '+79990000001' } : null;
  else if (url.pathname === '/api/categories') body = [category];
  else if (url.pathname === '/api/products') body = { items: products, total: products.length, page: 1, pages: 1, limit: 24, nextCursor: null };
  else if (url.pathname.startsWith('/api/products/')) body = products.find(product => product.slug === url.pathname.split('/').at(-1));
  else if (url.pathname === '/api/shop/status') body = { isOpen: true, closeTime: '21:00', nextOpenAt: null };
  else if (url.pathname === '/api/shop/settings') body = { minDeliverySubtotal: 0, deliveryEnabled: true, pickupEnabled: true, freeDeliveryEnabled: false, freeDeliveryThreshold: null };
  else if (url.pathname === '/api/orders/queue/offer') body = { queueLength: 0, position: null, wait: null, estimatedAssemblyMinutes: 15, assemblyConcurrency: 2, showScheduledOffer: false, preorderRequired: false, preparationStartsAt: null, market: { isOpen: true, today: '2026-10-12', nextOpenAt: null }, peakModeActive: false, slots: [] };
  else if (url.pathname === '/api/orders/quote') {
    const items = input.items.map(line => { const product = products.find(row => row.id === line.productId); const qty = estimatedQuantity(product, line.qty);
      return { ...line, product, status: 'AVAILABLE', lineTotal: qty === null ? null : lineAmount(product.price, qty, product.priceQty) }; });
    body = { items, valid: true, subtotal: items.some(item => item.lineTotal === null) ? null : items.reduce((sum, item) => sum + item.lineTotal, 0),
      knownSubtotal: items.reduce((sum, item) => sum + (item.lineTotal ?? 0), 0), pendingWeight: items.some(item => item.lineTotal === null), error: null,
      token: createHash('sha256').update(JSON.stringify(input)).digest('hex') };
  } else if (url.pathname === '/api/orders' && req.method === 'POST') {
    created = input;
    body = { id: 708, publicId, type: 'PICKUP', status: 'NEW', subtotal: null, total: null, deliveryPrice: 0, fulfillmentMode: 'ASAP', scheduledFor: null,
      createdAt: new Date().toISOString(), items: input.items.map(line => ({ ...line, productName: products.find(p => p.id === line.productId).name, total: null })) };
  } else if (url.pathname === `/api/orders/${publicId}`) {
    body = { ...staffOrder(), id: 708, status: 'NEW', assemblyStartedAt: null, queue: null, updatedAt: new Date().toISOString(), paymentDetails: null,
      items: (created?.items ?? []).map((line, index) => ({ ...products.find(p => p.id === line.productId), ...line, id: 7080 + index,
        productName: products.find(p => p.id === line.productId).name, productSlug: products.find(p => p.id === line.productId).slug,
        status: 'PENDING', actualQty: null, actualWeightGrams: null, actualPrice: null, actualTotal: null, total: null })) };
  } else if (url.pathname === '/api/staff/orders/707') body = staffOrder();
  else if (url.pathname === '/api/staff/orders/707/items/7071' && req.method === 'PATCH') { picked = input; body = staffOrder().items[0]; }
  else if (url.pathname === '/api/staff/orders/delivery/yandex/config') body = { yandexEnabled: false };
  else if (url.pathname === '/api/staff/extra-limits') body = { maxOrderExtraUnitPrice: 500000, maxOrderExtrasTotal: 1000000 };
  else if (url.pathname.endsWith('/coordination')) body = { issues: [], status: 'ASSEMBLING', unread: 0, notifications: [], readThrough: 0, responseMinutes: 10, smsAvailable: false };
  else if (url.pathname.endsWith('/messages')) body = { messages: [], revisions: [], unreadMessage: null, unreadRevision: null, readThrough: 0, hasMore: false };
  else if (url.pathname === '/api/staff/orders/new-count') body = { count: 0 };
  else if (url.pathname === '/api/favorites') body = { items: [] };
  res.end(JSON.stringify(body));
});
await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
let web, browser;
const cases = [];
try {
  web = await startWeb(`http://127.0.0.1:${api.address().port}/api`);
  browser = await openBrowser(await mkdtemp(join(tmpdir(), 'sale-browser-')));
  const { targetId } = await browser.command('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.command('Target.attachToTarget', { targetId, flatten: true });
  const command = (method, params = {}) => browser.command(method, params, sessionId);
  await command('Page.enable');
  await command('Page.addScriptToEvaluateOnNewDocument', { source: "if(location.hostname==='127.0.0.1'&&location.pathname.startsWith('/catalog'))localStorage.removeItem('cart')" });
  const evaluate = async expression => {
    const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + ': ' + result.exceptionDetails.exception?.description);
    return result.result.value;
  };
  async function wait(expression, message) {
    for (let attempt = 0; attempt < 160; attempt++) { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 100)); }
    await screenshot('failed.png');
    await writeFile(new URL('failed.json', artifacts), JSON.stringify({ message, path: await evaluate('location.pathname'), body: await evaluate('document.body.innerText'),
      item: await evaluate("document.querySelector('.items')?.outerHTML ?? document.querySelector('.item')?.outerHTML"), requests: requests.slice(-12) }, null, 2));
    throw new Error(message + ': ' + await evaluate('document.body.innerText.slice(-1600)'));
  }
  const card = slug => `document.querySelector('.card a[href="/product/${slug}"]').closest('article')`;
  const label = (slug, value) => `${card(slug)}.querySelector('.card__quantity')?.textContent.trim() === ${JSON.stringify(value)}`;
  async function screenshot(name) { const { data } = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); await writeFile(new URL(name, artifacts), Buffer.from(data, 'base64')); }
  for (const width of [320, 390, 1280]) {
    await command('Emulation.setDeviceMetricsOverride', { width, height: width < 640 ? 900 : 1000, deviceScaleFactor: 1, mobile: width < 640 });
    await command('Page.navigate', { url: 'about:blank' });
    await wait("location.href === 'about:blank'", 'Unload previous fixture');
    await command('Page.navigate', { url: web.base + '/catalog' });
    await wait("document.querySelectorAll('.card').length === 8 && !document.querySelector('.card__add').disabled", 'Catalog hydration');
    assert.equal(await evaluate(`${card(illustrationSlug)}.textContent.includes('Иллюстрация товара')`), true);
    assert.equal(await evaluate(`${card(illustrationSlug)}.querySelector('.price').textContent.includes('239,49')`), true);
    assert.equal(await evaluate(`${card('piece')}.querySelector('.card__sale') === null`), true);
    await command('Page.navigate', { url: web.base + '/product/' + illustrationSlug });
    await wait("Boolean(document.querySelector('.gallery__illustration')) && document.querySelector('.gallery img')?.naturalWidth > 0", 'Product illustration and real WebP loading');
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'Product overflow');
    await screenshot(`illustration-${width}.png`);
    await command('Page.navigate', { url: web.base + '/catalog' });
    await wait("document.querySelectorAll('.card').length === 8 && !document.querySelector('.card__add').disabled", 'Return to catalogue');
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'Catalog overflow');
    await evaluate(`${card('loose')}.querySelector('.card__add').click()`); await wait(label('loose', '500 г'), 'First loose portion');
    await evaluate(`${card('loose')}.querySelectorAll('.card__portion')[1].click()`); await wait(label('loose', '600 г'), 'Loose step');
    await evaluate(`${card('loose')}.querySelector('.card__portion').click()`); await wait(label('loose', '500 г'), 'Loose minimum');
    for (const [slug, first, second] of [['pack', '1 упаковка', '2 упаковки'], ['bunch', '1 пучок', '2 пучка'], ['whole', '1 кусок', '2 куска'], ['fish', '1 рыба', '2 рыбы'], ['piece', '1 шт.', '2 шт.']]) {
      await evaluate(`${card(slug)}.querySelector('.card__add').click()`); await wait(label(slug, first), slug + ' first');
      await evaluate(`${card(slug)}.querySelectorAll('.card__portion')[1].click()`); await wait(label(slug, second), slug + ' step');
    }
    await evaluate(`${card('bunch')}.querySelectorAll('.card__portion')[1].click()`); await wait(label('bunch', '3 пучка'), 'Three bunches');
    await evaluate(`${card('bunch')}.querySelector('.card__portion').click()`); await wait(label('bunch', '2 пучка'), 'Bunch decrement');
    await evaluate(`${card('fish')}.querySelector('.card__portion').click()`); await wait(label('fish', '1 рыба'), 'One whole fish');
    assert.equal(await evaluate(`${card('whole')}.querySelector('.price__unit').textContent.trim()`), '/ кг');
    assert.equal(await evaluate(`${card('fish')}.querySelector('.price__unit').textContent.trim()`), '/ кг');
    assert.equal(await evaluate(`${card('whole')}.textContent.includes(${JSON.stringify(saleExplanation(products[3]))})`), true);
    assert.equal(await evaluate(`Array.from(document.querySelectorAll('.card__portion')).every(button=>button.getBoundingClientRect().width>=44&&button.getBoundingClientRect().height>=44)`), true, 'Card touch targets');
    await screenshot(`catalog-${width}.png`);
    await command('Page.navigate', { url: web.base + '/cart' });
    await wait("document.querySelectorAll('.cart-items article').length === 6 && document.querySelector('.summary__submit button') && !document.querySelector('.summary__submit button').disabled", 'Unknown-weight checkout');
    assert.equal(await evaluate("document.querySelector('.summary').textContent.includes('После взвешивания')"), true);
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'Cart overflow');
    assert.equal(await evaluate("Array.from(document.querySelectorAll('.cart-items .qty__value')).every(label=>label.scrollWidth<=label.clientWidth&&getComputedStyle(label).textOverflow!=='ellipsis')"), true, 'Readable cart quantity units');
    await screenshot(`cart-${width}.png`);
    cases.push({ width, modelsInOneCategory: new Set(products.map(product => product.saleModel)).size, portionsAndSteps: true, fixedPieceCounts: true, bunchesAndPacks: true, threeBunches: true, wholeCountAndKgPrice: true, wholeFishCountsAndKgPrice: true, readableCartQuantityLabels: true, unknownSubtotalOrderable: true, overflow: false, touchTargets: true });
  }
  await evaluate(`Array.from(document.querySelectorAll('.type__item')).find(button=>button.textContent.includes('Самовывоз')).click(); for(const [selector,value] of [['input[autocomplete="name"]','Тестовый покупатель'],['input[autocomplete="tel"]','+79990000000']]){const input=document.querySelector(selector);input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));}`);
  await wait("!document.querySelector('.summary__submit button').disabled", 'Guest form');
  await evaluate("document.querySelector('.summary__submit button').click()");
  await wait(`location.pathname === '/order/${publicId}' && Boolean(document.querySelector('.order__head'))`, 'Guest checkout submission');
  assert.ok(created);
  assert.deepEqual(created.items.find(item => item.productId === 4), { productId: 4, qty: 2, quantityUnit: 'PIECE' });
  assert.deepEqual(created.items.find(item => item.productId === 5), { productId: 5, qty: 1, quantityUnit: 'PIECE' });
  assert.ok(created.items.every(item => !Object.hasOwn(item, 'price') && !Object.hasOwn(item, 'total')));
  staffMode = true;
  for (const width of [390, 1280]) {
    picked = null;
    await command('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 640 });
    await command('Page.navigate', { url: 'about:blank' });
    await wait("location.href === 'about:blank'", 'Unload previous assembly fixture');
    await command('Page.navigate', { url: web.base + `/staff/orders/707?fixture=${width}#assembly` });
    await wait("document.querySelectorAll('.whole-weight__inputs input').length === 2", 'Whole weights in staff UI');
    assert.equal(await evaluate("Boolean(document.querySelector('.weight'))"), false, 'No invented percentage tolerance');
    await evaluate("document.querySelectorAll('.whole-weight__inputs input').forEach((input,index)=>{input.value=index?'1500':'1700';input.dispatchEvent(new Event('input',{bubbles:true}));})");
    await screenshot(`assembly-input-${width}.png`);
    await evaluate("Array.from(document.querySelectorAll('.item__actions button')).find(button=>button.textContent.trim()==='Собрано').click()");
    await wait("document.querySelector('.item__actual-total')?.textContent.includes('5 280') || document.querySelector('.item__actual-total')?.textContent.includes('5 280')", 'Saved actual weight cost');
    assert.deepEqual(picked, { status: 'PICKED', actualQty: 2, pieceWeights: [1700, 1500] });
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'Assembly overflow');
    await evaluate("document.querySelector('.item__toggle').click();document.querySelector('.item').scrollIntoView({block:'start'})");
    await screenshot(`assembly-${width}.png`);
  }
  const result = { passed: true, cases, guestCheckout: true, noClientPrices: true, assemblyIndividualWeights: true, networkScope: 'LOCAL_FIXTURES_ONLY' };
  await writeFile(new URL('result.json', artifacts), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally { await browser?.close(); await web?.close(); api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); }
