import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { startWeb } from './browser.mjs';

const artifacts = await mkdtemp(join(tmpdir(), 'korzina-point-grid-'));
const categories = [{ id: 1, name: 'Фрукты', slug: 'fruits', active: true }, { id: 2, name: 'Свежие ягоды с рынка и лесные ягоды', slug: 'berries', active: true }];
const point = { id: 10, slug: 'ours', name: 'Наша точка «Овощи и фрукты»', cardColor: '#00FF00', isOurPoint: true, kind: 'STALL', floor: 2 };
const products = Array.from({ length: 24 }, (_, i) => ({ id: i + 1, name: 'Яблоки красные ' + (i + 1), slug: 'apples-' + (i + 1),
  price: 12345 + i, priceStatus: 'AUDITED', priceQty: 1000, unit: 'GRAM', min: 500, step: 100, portionQty: 500,
  category: categories[0], marketPoint: point, images: [{ url: '/images/hero/hero-0.webp', alt: 'Яблоки' }],
  isHit: false, isSeasonal: false, seasonalStartsAt: null, seasonalEndsAt: null }));
Object.assign(products[0], { name: 'Яблоки', isHit: true, isSeasonal: true });
products[3].name = 'Очень длинное название свежего продукта в нескольких строках';
products[3].images = [];
Object.assign(products[1], { price: 123456, unit: 'PIECE', priceQty: 1, min: 1, step: 1, portionQty: 1 });
Object.assign(products[2], { price: 99999999, unit: 'BUNCH', priceQty: 1, min: 1, step: 1, portionQty: 1 });
Object.assign(products[3], { unit: 'PACK', priceQty: 1, min: 1, step: 1, portionQty: 1 });
const adminProduct = { ...products[0], price: 10000, sellerPrice: 10000, customerPrice: 12500, serviceMarkupPercent: 25, serviceMarkup: 2500,
  description: 'Наши яблоки', categoryId: 1, marketPointId: 10, active: true, sort: 0, hitMode: 'AUTO', autoHit: false,
  seasonalMode: 'OFF', seasonTemplateId: null, settlementMode: 'UNSET', basePrice: null, images: [], sourceUrl: null, sourceCheckedAt: null };
let user = null;
const mutations = [], errors = [], checks = [];
const api = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1'), path = url.pathname;
  response.setHeader('Content-Type', 'application/json');
  if (request.headers.origin) {
    response.setHeader('Access-Control-Allow-Origin', request.headers.origin);
    response.setHeader('Access-Control-Allow-Credentials', 'true');
    response.setHeader('Access-Control-Allow-Headers', 'content-type');
    response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  }
  if (request.method === 'OPTIONS') return response.end();
  let input;
  if (['POST', 'PATCH'].includes(request.method)) {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    try { input = JSON.parse(Buffer.concat(chunks).toString()); } catch { input = null; }
    mutations.push({ path, method: request.method, body: input });
  }
  let body = [];
  if (path === '/api/auth/me') body = user;
  else if (['/api/categories', '/api/owner/categories', '/api/admin/categories'].includes(path)) body = categories;
  else if (['/api/categories/points', '/api/owner/points', '/api/admin/market-map/points'].includes(path)) body = [point];
  else if (path === '/api/products') body = { items: products, total: products.length, nextCursor: null, page: 1, pages: 1, limit: 24,
    ...(url.searchParams.get('category') && url.searchParams.get('q') ? { groupTotals: { current: 0, others: 24 } } : {}) };
  else if (path === '/api/admin/users') body = { items: [{ id: 7, name: 'Владелец', phone: '+79990000007', role: 'SELLER', ownedPoints: [], protected: false, orders: 0, completed: 0, spent: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), verifiedAt: null }], page: 1, pages: 1, total: 1 };
  else if (path === '/api/owner/products/1' || path === '/api/admin/products/1') body = adminProduct;
  else if (path.endsWith('/products/pricing')) body = { sellerPrice: input.price, customerPrice: Math.round(input.price * 1.25), serviceMarkupPercent: 25, serviceMarkup: Math.round(input.price * .25) };
  else if (path === '/api/orders/quote') {
    const items = input.items.map(line => { const product = products.find(p => p.id === line.productId); return { ...line, product, status: 'AVAILABLE', lineTotal: Math.round(product.price * line.qty / product.priceQty) }; });
    body = { items, subtotal: items.reduce((sum, line) => sum + line.lineTotal, 0), valid: true, error: null, token: 'fixture' };
  }
  else if (path === '/api/cart') body = { revision: '0', items: [], products: [], subtotal: 0, valid: true, error: null };
  else if (path === '/api/favorites') body = { items: [] };
  else if (path === '/api/order-phones') body = { primaryPhone: null, phones: [] };
  else if (path === '/api/orders/unread' || path === '/api/staff/orders/unread') body = { count: 0, latestOrderId: null };
  else if (path === '/api/staff/orders/new-summary') body = { count: 0, latestOrderId: null };
  else if (path === '/api/in-app/events') body = { scope: null, events: [], hasMore: false };
  else if (path === '/api/shop/settings') body = { deliveryEnabled: true, pickupEnabled: true, minDeliverySubtotal: 0 };
  else if (path === '/api/home/slides') body = { slides: [], serverNow: new Date().toISOString(), validUntil: null };
  response.end(JSON.stringify(body));
});
let web, browser;
try {
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  web = await startWeb(`http://127.0.0.1:${api.address().port}/api`);
  browser = await chromium.launch({ executablePath: process.env.CATALOG_BROWSER_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const context = await browser.newContext({ viewport: { width: 375, height: 844 }, isMobile: true, hasTouch: true });
  await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (/hydration.*mismatch/i.test(message.text())) errors.push(message.text()); });
  await page.goto(web.base + '/catalog', { waitUntil: 'networkidle' });
  const columnCount = () => page.locator('.grid').first().evaluate(grid => getComputedStyle(grid).gridTemplateColumns.split(' ').length);
  assert.equal(await columnCount(), 2);
  for (const columns of [2, 3, 4]) {
    await page.getByRole('button', { name: `${columns} карточки в ряд`, exact: true }).click();
    assert.equal(await columnCount(), columns);
    for (const width of [320, 375, 430]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(await columnCount(), columns);
      const placement = await page.locator('.catalog__head .density').evaluate(control => {
        const box = control.getBoundingClientRect(), head = control.parentElement.getBoundingClientRect();
        return { delta: box.x + box.width / 2 - head.x - head.width / 2, width: innerWidth, control: box.toJSON(), head: head.toJSON(), columns: getComputedStyle(control.parentElement).gridTemplateColumns };
      });
      await page.screenshot({ path: join(artifacts, `grid-${columns}-${width}.png`) });
      assert.ok(Math.abs(placement.delta) < 1, JSON.stringify(placement));
      assert.equal(await page.locator('.density__label').innerText(), 'Карточек в ряд');
      assert.deepEqual((await page.locator('.density__option').allTextContents()).map(text => text.trim()), ['2', '3', '4']);
      assert.equal(await page.locator('.density__option[aria-pressed="true"]').innerText(), String(columns));
      assert.ok(await page.locator('.density__option').evaluateAll(buttons => buttons.every(button => {
        const box = button.getBoundingClientRect();
        return box.width >= 44 && box.height >= 36;
      })));
      assert.equal(await page.locator('.breadcrumbs').getByRole('link', { name: 'Главная', exact: true }).getAttribute('href'), '/');
      assert.equal(await page.locator('.breadcrumbs__short').isVisible(), width < 368);
      const card = page.locator('.card').first();
      const sizes = await page.locator('.card').evaluateAll(cards => cards.map(card => ({
        height: card.getBoundingClientRect().height,
        title: card.querySelector('.card__title').getBoundingClientRect().height,
        line: Number.parseFloat(getComputedStyle(card.querySelector('.card__title')).lineHeight),
      })));
      assert.ok(Math.max(...sizes.map(size => size.height)) - Math.min(...sizes.map(size => size.height)) < 1, JSON.stringify(sizes));
      assert.ok(sizes.every(size => Math.abs(size.title - 2 * size.line) < 1));
      const beforeHeight = await card.evaluate(card => card.getBoundingClientRect().height);
      const beforeButton = await card.locator('.card__add').evaluate(button => button.getBoundingClientRect().height);
      await card.locator('.card__add').click();
      await card.locator('.card__control').waitFor();
      await card.locator('.card__quantity').waitFor({ state: 'visible' });
      const added = await card.evaluate(card => {
        const box = card.getBoundingClientRect(), image = card.querySelector('.card__media').getBoundingClientRect();
        const badge = card.querySelector('.card__quantity').getBoundingClientRect();
        const control = card.querySelector('.card__control');
        return { height: box.height, button: control.getBoundingClientRect().height, buttons: control.querySelectorAll('button').length,
          quantityOverPhoto: badge.top >= image.top && badge.bottom <= image.bottom + 1,
          quantityCenterX: badge.x + badge.width / 2 - image.x - image.width / 2,
          quantityCenterY: badge.y + badge.height / 2 - image.y - image.height / 2,
          quantityAboveRibbons: Number(getComputedStyle(card.querySelector('.card__quantity')).zIndex) > Number(getComputedStyle(card.querySelector('.card__badges')).zIndex),
          controlText: control.textContent.trim() };
      });
      assert.ok(Math.abs(added.height - beforeHeight) < 1, JSON.stringify({ beforeHeight, added }));
      assert.equal(added.button, beforeButton);
      assert.equal(added.buttons, 2);
      assert.equal(added.controlText, '');
      assert.ok(added.quantityOverPhoto);
      assert.ok(Math.abs(added.quantityCenterX) < 1 && Math.abs(added.quantityCenterY) < 1 && added.quantityAboveRibbons, JSON.stringify(added));
      await card.locator('.card__portion').last().click();
      await page.waitForFunction(() => document.querySelector('#__nuxt').__vue_app__.config.globalProperties.$nuxt.$pinia._s.get('cart').qty(1) === 600);
      assert.equal(await card.evaluate(card => card.getBoundingClientRect().height), beforeHeight);
      await page.screenshot({ path: join(artifacts, `added-${columns}-${width}.png`) });
      if (columns === 4 && width === 375) {
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.screenshot({ path: join(artifacts, 'added-dark-4-375.png') });
        await page.emulateMedia({ colorScheme: 'light' });
      }
      await card.locator('.card__portion').first().click();
      await page.waitForFunction(() => document.querySelector('#__nuxt').__vue_app__.config.globalProperties.$nuxt.$pinia._s.get('cart').qty(1) === 500);
      await card.locator('.card__portion').first().click();
      await card.locator('.card__add').waitFor();
      assert.equal(await card.evaluate(card => card.getBoundingClientRect().height), beforeHeight);
      await page.getByRole('button', { name: 'Сортировка', exact: true }).click();
      const menu = page.getByRole('menu', { name: 'Сортировка товаров' });
      await menu.waitFor();
      await menu.evaluate(async menu => {
        const content = menu.closest('.product-sort__content');
        await Promise.all((content?.getAnimations({ subtree: true }) ?? []).map(animation => animation.finished.catch(() => {})));
      });
      const sortLayout = await menu.evaluate(menu => {
        const box = menu.getBoundingClientRect();
        return { left: box.left, right: box.right, viewport: innerWidth, height: box.height,
          scroll: menu.scrollWidth - menu.clientWidth,
          labelsHidden: [...menu.querySelectorAll('.product-sort__label')].every(label => getComputedStyle(label).display === 'none') };
      });
      assert.ok(Math.abs(sortLayout.left) < 1 && Math.abs(sortLayout.right - sortLayout.viewport) < 1, JSON.stringify(sortLayout));
      assert.ok(sortLayout.scroll <= 1 && sortLayout.height <= 48 && sortLayout.labelsHidden, JSON.stringify(sortLayout));
      assert.equal(await menu.getByRole('menuitemradio').count(), 5);
      await page.screenshot({ path: join(artifacts, `sort-${columns}-${width}.png`) });
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Escape');
      await menu.waitFor({ state: 'hidden' });

      const prices = await page.locator('.card .price').evaluateAll(prices => prices.map(price => {
        const value = price.querySelector('.price__value').getBoundingClientRect();
        const unit = price.querySelector('.price__unit').getBoundingClientRect();
        const box = price.getBoundingClientRect();
        return { singleLine: value.top < unit.bottom && unit.top < value.bottom, fits: unit.right <= box.right + 1, text: price.textContent };
      }));
      assert.ok(prices.every(price => price.singleLine && price.fits), JSON.stringify(prices));
      const layout = await card.evaluate(card => {
        const image = card.querySelector('.card__img').getBoundingClientRect();
        const title = card.querySelector('.card__title').getBoundingClientRect();
        const price = card.querySelector('.price').getBoundingClientRect();
        return { height: card.getBoundingClientRect().height, imageRatio: image.width / image.height, titleGap: price.top - title.bottom };
      });
      if (columns > 2) assert.ok(layout.height < (width / columns) + 95, JSON.stringify(layout));
      assert.ok(Math.abs(layout.imageRatio - 4 / 3) < 0.01, JSON.stringify(layout));
      if (columns > 2) assert.ok(layout.titleGap < 5, JSON.stringify(layout));
      if (width === 320) console.log('Compact layout: ' + JSON.stringify({ columns, ...layout }));
      assert.ok(await card.locator('.card__img').isVisible());
      assert.ok(await card.locator('.price').isVisible());
      assert.ok(await card.locator('.card__add').isVisible());
      assert.equal(await card.evaluate(card => getComputedStyle(card).borderColor), 'rgb(0, 255, 0)');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.screenshot({ path: join(artifacts, `grid-${columns}-${width}.png`) });
    }
    await page.reload({ waitUntil: 'networkidle' }); assert.equal(await columnCount(), columns);
    checks.push(`mobile ${columns} columns: centered cart quantity above ribbons, equal stable card heights, single-line prices, full-width icon sorting at 320/375/430px`);
  }
  await page.goto(web.base, { waitUntil: 'networkidle' });
  for (const width of [320, 375, 430]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(await page.locator('.home__head .density').evaluate(control => {
      const box = control.getBoundingClientRect(), head = control.parentElement.getBoundingClientRect();
      return Math.abs(box.x + box.width / 2 - head.x - head.width / 2) < 1 && box.left >= head.left && box.right <= head.right;
    }));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: join(artifacts, `home-${width}.png`) });
  }
  assert.equal(await page.locator('.categories .density').count(), 0);
  assert.equal(await columnCount(), 4);
  checks.push('labeled numeric grid buttons have 44px touch targets, stay centered in catalog and home headings, and preserve selection');
  await page.locator('.card__add').first().click();
  await page.locator('.card__control').first().waitFor();
  assert.equal(await page.locator('.card').first().evaluate(card => getComputedStyle(card).borderColor), 'rgb(0, 255, 0)');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.setViewportSize({ width: 1280, height: 900 }); assert.equal(await columnCount(), 6);
  assert.ok(await page.locator('.card').first().evaluate(card => {
    const image = card.querySelector('.card__media').getBoundingClientRect();
    const quantity = card.querySelector('.card__quantity').getBoundingClientRect();
    return Math.abs(quantity.x + quantity.width / 2 - image.x - image.width / 2) < 1 &&
      Math.abs(quantity.y + quantity.height / 2 - image.y - image.height / 2) < 1;
  }));
  checks.push('cart controls preserve point border; desktop keeps cart quantity centered and uses responsive grid');
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await desktop.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  const desktopPage = await desktop.newPage();
  await desktopPage.goto(web.base + '/catalog', { waitUntil: 'networkidle' });
  await desktopPage.getByRole('button', { name: 'Сортировка', exact: true }).click();
  const desktopMenu = desktopPage.getByRole('menu', { name: 'Сортировка товаров' });
  await desktopMenu.evaluate(async menu => {
    await Promise.all((menu.closest('.product-sort__content')?.getAnimations({ subtree: true }) ?? []).map(animation => animation.finished.catch(() => {})));
  });
  const desktopSort = await desktopMenu.evaluate(menu => {
    const box = menu.getBoundingClientRect();
    return { left: box.left, right: box.right, viewport: document.documentElement.clientWidth,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      labelsVisible: [...menu.querySelectorAll('.product-sort__label')].every(label => getComputedStyle(label).display !== 'none') };
  });
  assert.ok(Math.abs(desktopSort.left) < 1 && Math.abs(desktopSort.right - desktopSort.viewport) < 1 && desktopSort.overflow <= 1 && desktopSort.labelsVisible, JSON.stringify(desktopSort));
  await desktop.close();
  checks.push('desktop sort fills the viewport without horizontal overflow and keeps its labels');
  await page.goto(web.base + '/catalog/berries?q=' + encodeURIComponent('яблоко'), { waitUntil: 'networkidle' });
  assert.ok(await page.getByText('В данной категории ничего не нашлось', { exact: true }).isVisible());
  assert.ok(await page.getByRole('heading', { name: 'Результаты поиска во всём каталоге' }).isVisible());
  assert.ok(await page.locator('.card').first().isVisible()); checks.push('empty category displays whole-catalog results');
  const breadcrumbs = page.getByRole('navigation', { name: 'Хлебные крошки' });
  assert.ok(await breadcrumbs.getByRole('link', { name: 'Главная', exact: true }).isVisible());
  assert.equal(await breadcrumbs.locator('[aria-current="page"]').innerText(), categories[1].name);
  assert.ok(await page.locator('.density').isHidden());
  for (const width of [320, 360, 367, 368, 375, 430]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(await breadcrumbs.getByRole('link', { name: 'Главная', exact: true }).isHidden());
    const catalogLink = breadcrumbs.getByRole('link', { name: 'Каталог', exact: true });
    assert.ok(await catalogLink.isVisible());
    assert.equal(new URL(await catalogLink.getAttribute('href'), web.base).searchParams.get('q'), 'яблоко');
    assert.equal(await breadcrumbs.locator('.breadcrumbs__short').isVisible(), width < 368);
    const current = breadcrumbs.locator('[aria-current="page"]');
    assert.equal(await current.getAttribute('title'), categories[1].name);
    assert.equal(await current.innerText(), categories[1].name);
    const headingLayout = await page.locator('.catalog__head').evaluate(head => {
      const box = head.getBoundingClientRect();
      const control = head.querySelector('.density').getBoundingClientRect();
      const crumbs = head.querySelector('.breadcrumbs').getBoundingClientRect();
      const current = head.querySelector('.breadcrumbs [aria-current="page"]');
      return { centered: Math.abs(control.x + control.width / 2 - box.x - box.width / 2) < 1,
        separated: crumbs.right <= control.left, currentWidth: current.getBoundingClientRect().width,
        truncated: current.scrollWidth > current.clientWidth, ellipsis: getComputedStyle(current).textOverflow };
    });
    assert.ok(headingLayout.centered && headingLayout.separated && headingLayout.currentWidth > 10 && headingLayout.truncated && headingLayout.ellipsis === 'ellipsis', JSON.stringify({ width, ...headingLayout }));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    if (width === 320 || width === 375) await page.screenshot({ path: join(artifacts, `breadcrumbs-${width}.png`) });
  }
  checks.push('compact breadcrumbs retain accessible names and search links, abbreviate below 368px, and truncate long categories without shifting the grid control');
  user = { id: 7, name: 'Владелец', phone: '+79990000007', role: 'USER', verifiedAt: '2026-10-18T12:00:00Z', ownedPoints: [{ marketPointId: 10 }], telegram: null };
  await page.goto(web.base + '/staff/products/1', { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Редактировать свой товар' }).waitFor();
  assert.equal(await page.getByText('Внутренний расчёт', { exact: true }).count(), 0);
  assert.equal(await page.getByLabel('Наценка сервиса, %', { exact: true }).count(), 0);
  assert.equal(await page.getByText('Отметка ХИТ', { exact: true }).count(), 0);
  await page.locator('form input[maxlength="160"]').fill('Наши яблоки');
  await Promise.all([page.waitForResponse(response => response.url().endsWith('/owner/products/1') && response.request().method() === 'PATCH'), page.getByRole('button', { name: 'Сохранить изменения', exact: true }).click()]);
  const update = mutations.findLast(value => value.path === '/api/owner/products/1');
  assert.equal(update.body.name, 'Наши яблоки');
  for (const key of ['serviceMarkupPercent', 'hitMode', 'settlementMode', 'basePrice', 'sourceCheckedAt', 'sort']) assert.ok(!Object.hasOwn(update.body, key), key);
  await page.screenshot({ path: join(artifacts, 'owner-editor.png') });
  checks.push('owner editor hides admin fields and submits only permitted own-product data');
  user = { ...user, id: 1, role: 'ADMIN', ownedPoints: [] };
  await page.goto(web.base + '/admin/users', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Точки владельца', exact: true }).click();
  await page.getByRole('checkbox', { name: /Наша точка/ }).check();
  await Promise.all([page.waitForResponse(response => response.url().endsWith('/admin/users/7/points') && response.request().method() === 'PATCH'), page.getByRole('button', { name: 'Сохранить права', exact: true }).click()]);
  assert.deepEqual(mutations.findLast(value => value.path.endsWith('/users/7/points')).body, { pointIds: [10] });
  checks.push('administrator assigns owner points independently of existing seller role');
  await page.goto(web.base + '/admin/products/1', { waitUntil: 'networkidle' });
  await page.locator('input[type="number"][max="100"]').fill('30');
  await Promise.all([page.waitForResponse(response => response.url().endsWith('/admin/products/1') && response.request().method() === 'PATCH'), page.getByRole('button', { name: 'Сохранить изменения', exact: true }).click()]);
  assert.equal(mutations.findLast(value => value.path === '/api/admin/products/1').body.serviceMarkupPercent, 30);
  checks.push('administrator edits the product service markup');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ artifacts, checks, mutations: mutations.filter(value => value.method === 'PATCH'), errors }, null, 2));
} finally {
  await browser?.close(); await web?.close(); await new Promise(resolve => api.close(resolve));
  console.log('Artifacts: ' + artifacts);
  await writeFile(join(artifacts, 'report.json'), JSON.stringify({ checks, errors }, null, 2));
}
