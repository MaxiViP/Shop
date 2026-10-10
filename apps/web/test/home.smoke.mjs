// Production-built web, isolated local API fixtures and a separate headless browser profile.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBrowser, startWeb } from './browser.mjs';

const artifacts = process.env.HOME_SMOKE_ARTIFACT_DIR ?? await mkdtemp(join(tmpdir(), 'korzina-home-smoke-'));
const categories = [{ id: 1, name: 'Фрукты', slug: 'fruits' }];
const products = Array.from({ length: 160 }, (_, index) => ({ id: index + 1, slug: `home-fixture-${index + 1}`, name: `Продукт с рынка ${index + 1}`,
  price: 11_000, priceStatus: 'SOURCE', priceQty: 1, unit: 'PIECE', step: 1, min: 1, portionQty: 1,
  marketPoint: { slug: 'fixture-point', name: 'Лавка с рынка' }, category: categories[0], images: [],
  isSeasonal: index % 4 === 1 || index % 4 === 3, isHit: index % 4 >= 2, seasonalStartsAt: null, seasonalEndsAt: null }));
const original = [
  { id: 1, title: 'Продукты с настоящего рынка', text: 'Выбирайте товары из разных лавок в одном каталоге.', image: '/images/hero/hero-0.webp' },
  { id: 2, title: 'Очень длинный заголовок о продуктах с настоящего московского рынка и удобном выборе из разных торговых лавок',
    text: 'Выбирайте продукты из разных торговых точек и уточняйте детали в чате заказа. Продавец покажет фото прилавка, а вы сможете отметить нужный продукт. Оформляйте доставку или самовывоз в корзине.', image: '/images/hero/hero-1.webp' },
  { id: 3, title: 'Объявление без фонового изображения', text: 'Важная информация хорошо видна в основном содержимом слайда.', image: null },
].map(slide => ({ ...slide, content: 'CUSTOM', eyebrow: 'Прилавки рынка', position: 'center', buttonLabel: 'Выбрать продукты', to: '/catalog', endsAt: null }));
let currentSlides = [...original], role = null, recordId = 20, failSlideRefresh = false;
let adminSlides = original.map(slide => ({ ...slide, type: 'PERMANENT', published: true, active: true, priority: false, sortOrder: slide.id - 1, startsAt: null, status: 'ACTIVE' }));
let seasonTemplates = [];
const adminProducts = products.map(product => ({ ...product, seasonalMode: 'OFF', seasonTemplateId: null, seasonTemplate: null }));
let hitSettings = { periodDays: 30, minOrders: 3, shareBps: 1500, lastCalculatedAt: new Date().toISOString() };
const requests = [];
const settings = { minDeliverySubtotal: 0, deliveryEnabled: true, pickupEnabled: true, freeDeliveryEnabled: true, freeDeliveryThreshold: 22_000 };
const api = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  res.setHeader('Content-Type', 'application/json');
  if (req.headers.origin && /^http:\/\/127\.0\.0\.1:\d+$/.test(req.headers.origin)) {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin); res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'content-type'); res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  }
  if (req.method === 'OPTIONS') { res.end(); return; }
  if (url.pathname === '/api/home/slides' && failSlideRefresh) { res.statusCode = 503; res.end(JSON.stringify({ message: 'Fixture offline' })); return; }
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const input = chunks.length && req.headers['content-type']?.includes('application/json') ? JSON.parse(Buffer.concat(chunks).toString()) : null;
  requests.push({ path: url.pathname, method: req.method, query: Object.fromEntries(url.searchParams), input });
  let body;
  if (url.pathname === '/api/auth/me') body = role ? { id: 1, name: 'Fixture admin', role, phone: '+79990000001', verifiedAt: new Date().toISOString(), telegram: null } : null;
  else if (url.pathname === '/api/home/slides') body = { slides: currentSlides.filter(slide => !slide.endsAt || Date.parse(slide.endsAt) > Date.now()), serverNow: new Date().toISOString(), validUntil: new Date(Math.min(Date.now() + 60_000, ...currentSlides.filter(slide => slide.endsAt && Date.parse(slide.endsAt) > Date.now()).map(slide => Date.parse(slide.endsAt)))).toISOString() };
  else if (url.pathname === '/api/categories') body = categories;
  else if (url.pathname === '/api/shop/settings') body = settings;
  else if (url.pathname === '/api/admin/categories') body = categories;
  else if (url.pathname === '/api/admin/hits' && req.method === 'GET') body = { settings: hitSettings,
    items: products.slice(0, 20).map((product, index) => ({ ...product, hitOrders: index < 3 ? 3 : 0, hitSoldUnits: index < 3 ? '5' : '0', hitRank: index + 1 })), total: products.length, page: 1, limit: 20, pages: 8 };
  else if (url.pathname === '/api/admin/hits/settings') { hitSettings = { ...hitSettings, ...input, lastCalculatedAt: new Date().toISOString() }; body = { skipped: false, settings: hitSettings }; }
  else if (url.pathname === '/api/admin/hits/recalculate') { hitSettings.lastCalculatedAt = new Date().toISOString(); body = { skipped: false, settings: hitSettings }; }
  else if (url.pathname === '/api/admin/seasons' && req.method === 'GET') body = seasonTemplates;
  else if (url.pathname === '/api/admin/seasons' && req.method === 'POST') { body = { ...input, id: ++recordId, _count: { products: 0 } }; seasonTemplates.push(body); }
  else if (/^\/api\/admin\/seasons\/\d+$/.test(url.pathname)) {
    const id = Number(url.pathname.split('/').at(-1)), index = seasonTemplates.findIndex(template => template.id === id);
    body = { ...seasonTemplates[index], ...input }; seasonTemplates[index] = body;
  } else if (url.pathname === '/api/admin/products') {
    const offset = (Number(url.searchParams.get('page') ?? 1) - 1) * 20;
    body = { items: adminProducts.slice(offset, offset + 20), total: adminProducts.length, page: 1, limit: 20, pages: 8 };
  } else if (url.pathname === '/api/admin/seasons/assign') {
    for (const product of adminProducts.filter(product => input.ids.includes(product.id))) Object.assign(product, {
      seasonalMode: input.seasonalMode, seasonTemplateId: input.seasonTemplateId,
      seasonTemplate: seasonTemplates.find(template => template.id === input.seasonTemplateId) ?? null,
    });
    body = { count: input.ids.length };
  }
  else if (url.pathname === '/api/orders/queue/offer') body = { showScheduledOffer: false, preorderRequired: false, slots: [], market: { isOpen: true } };
  else if (url.pathname === '/api/products') {
    const items = products.filter(product => url.searchParams.get('tag') === 'seasonal' ? product.isSeasonal : url.searchParams.get('tag') === 'hit' ? product.isHit : true);
    const offset = Number(url.searchParams.get('cursor') ?? 0), limit = Number(url.searchParams.get('limit') ?? 24);
    body = { items: items.slice(offset, offset + limit), total: items.length, nextCursor: offset + limit < items.length ? String(offset + limit) : null,
      seed: '00000000-0000-4000-8000-000000000001', page: 1, limit, pages: Math.ceil(items.length / limit) };
  } else if (url.pathname === '/api/orders/quote') {
    const items = input.items.map(line => ({ ...line, product: products.find(product => product.id === line.productId), status: 'AVAILABLE', lineTotal: 11_000 * line.qty }));
    const subtotal = items.reduce((sum, line) => sum + line.lineTotal, 0), eligible = subtotal >= 22_000;
    body = { items, subtotal, valid: true, token: String(subtotal), error: null, delivery: { enabled: true, threshold: 22_000,
      remaining: Math.max(0, 22_000 - subtotal), eligible, progress: Math.min(100, Math.floor(subtotal * 100 / 22_000)), price: eligible ? 0 : null, total: eligible ? subtotal : null } };
  } else if (url.pathname === '/api/admin/home-slides/preview') body = { slide: { ...input, id: 0, title: input.title.replaceAll('{threshold}', '220 ₽') }, reason: null };
  else if (url.pathname === '/api/admin/home-slides/reorder') { adminSlides = input.ids.map((id, sortOrder) => ({ ...adminSlides.find(slide => slide.id === id), sortOrder })); body = { ok: true }; }
  else if (url.pathname === '/api/admin/home-slides' && req.method === 'GET') body = adminSlides;
  else if (url.pathname === '/api/admin/home-slides' && req.method === 'POST') { body = { ...input, id: ++recordId, status: input.published ? 'ACTIVE' : 'DRAFT' }; adminSlides.push(body); }
  else if (/^\/api\/admin\/home-slides\/\d+\/copy$/.test(url.pathname)) { const id = Number(url.pathname.split('/').at(-2)); body = { ...adminSlides.find(slide => slide.id === id), id: ++recordId, title: 'Копия слайда', published: false, priority: false, status: 'DRAFT' }; adminSlides.push(body); }
  else if (/^\/api\/admin\/home-slides\/\d+$/.test(url.pathname)) {
    const id = Number(url.pathname.split('/').at(-1));
    if (req.method === 'DELETE') { adminSlides = adminSlides.filter(slide => slide.id !== id); body = { ok: true }; }
    else { const index = adminSlides.findIndex(slide => slide.id === id); body = { ...adminSlides[index], ...input, status: input.published === false ? 'DRAFT' : 'ACTIVE' }; adminSlides[index] = body; }
  } else if (url.pathname === '/api/orders/unread' || url.pathname === '/api/staff/orders/unread') body = { count: 0 };
  else if (url.pathname.includes('/favorites')) body = { items: [] };
  else if (url.pathname === '/api/staff/orders' || url.pathname === '/api/orders') body = [];
  else if (url.pathname === '/api/order-phones') body = { primaryPhone: null, phones: [] };
  else body = [];
  res.end(JSON.stringify(body));
});

let web, browser;
const results = [];
try {
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  web = await startWeb(`http://127.0.0.1:${api.address().port}/api`);
  browser = await openBrowser(await mkdtemp(join(artifacts, 'browser-')));
  const command = browser.command;
  async function page(path, width, initial = '') {
    const { targetId } = await command('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await command('Target.attachToTarget', { targetId, flatten: true });
    await command('Page.enable', {}, sessionId); await command('Runtime.enable', {}, sessionId);
    await command('Emulation.setDeviceMetricsOverride', { width, height: 950, deviceScaleFactor: 1, mobile: width < 768 }, sessionId);
    await command('Page.addScriptToEvaluateOnNewDocument', { source: `window.smokeErrors=[];const warn=console.warn;console.warn=(...args)=>{smokeErrors.push(args.join(' '));warn(...args)};addEventListener('error',e=>smokeErrors.push(e.message));${initial}` }, sessionId);
    await command('Page.navigate', { url: web.base + path }, sessionId);
    await command('Page.bringToFront', {}, sessionId);
    const evaluate = async expression => {
      const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
      assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails)); return result.result.value;
    };
    await evaluate(`(async()=>{for(let i=0;i<200;i++){if(document.querySelector('#__nuxt')?.__vue_app__?.config.globalProperties.$nuxt?.isHydrating===false)return;await new Promise(r=>setTimeout(r,50))}throw new Error('Hydration timeout')})()`);
    return { targetId, sessionId, evaluate, async close() { await command('Target.closeTarget', { targetId }); } };
  }

  for (const width of [320, 360, 390, 768, 1024, 1440]) {
    const html = await (await fetch(web.base)).text(); assert.ok(html.includes(original[0].title) && html.includes('hero__slide'));
    const p = await page('/', width);
    const layout = await p.evaluate(`(async()=>{
      const root=document.querySelector('.hero'), content=root.querySelector('.hero__content'), initial=root.getBoundingClientRect().height;
      const controls=root.querySelector('.hero__controls').getBoundingClientRect(), button=content.querySelector('.hero__action').getBoundingClientRect();
      const header=document.querySelector('header.header').getBoundingClientRect();
      if(document.documentElement.scrollWidth>innerWidth)throw new Error('Page overflow');
      if(content.getBoundingClientRect().right>root.getBoundingClientRect().right)throw new Error('Content overflow');
      if(button.bottom>controls.top)throw new Error('CTA overlaps controls');
      if(root.getBoundingClientRect().top<header.bottom)throw new Error('Header overlaps hero');
      const heights=[];
      for(let i=0;i<4;i++){root.querySelector('[aria-label="Следующий слайд"]').click();await new Promise(r=>setTimeout(r,30));heights.push(root.getBoundingClientRect().height)}
      if(heights.some(height=>Math.abs(height-initial)>1))throw new Error('Slide height shifted');
      for(const media of document.querySelectorAll('.card__media')){
        const badge=media.querySelector('.card__badges'), favorite=media.querySelector('.card__favorite');if(!badge)continue;
        const a=badge.getBoundingClientRect(), b=favorite.getBoundingClientRect(), c=media.getBoundingClientRect();
        if(a.right>b.left||a.left<c.left-1||a.bottom>c.bottom)throw new Error('Badges overlap/outside image');
        if(getComputedStyle(badge).pointerEvents!=='none')throw new Error('Badges intercept clicks');
      }
      if(window.smokeErrors.some(e=>/hydration|mismatch|ReferenceError|TypeError|no active component|no active effect/i.test(e)))throw new Error(smokeErrors.join(';'));
      return {width:innerWidth,height:initial,heights,cards:document.querySelectorAll('.card').length,hydration:true,overflow:false};
    })()`);
    const screenshot = await command('Page.captureScreenshot', { format: 'png' }, p.sessionId);
    await writeFile(join(artifacts, `home-${width}.png`), Buffer.from(screenshot.data, 'base64'));
    results.push(layout); console.log(JSON.stringify(layout)); await p.close();
  }

  // Reading time ranges from 8 to 25 seconds; only this range is accelerated.
  // home-content.test.mjs verifies the real duration independently of this wrapper.
  const autoplay = await page('/', 390, `window.smokeDelays=[];const originalTimeout=window.setTimeout;window.setTimeout=(fn,ms,...args)=>{if(ms>=8000&&ms<=25000)smokeDelays.push(ms);return originalTimeout(fn,ms>=8000&&ms<=25000?150:ms,...args)};`);
  await command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, autoplay.sessionId);
  const autoResult = await autoplay.evaluate(`(async()=>{
    const sleep=ms=>new Promise(r=>setTimeout(r,ms)), root=document.querySelector('.hero'), count=()=>root.querySelector('.hero__counter').textContent;
    await sleep(50);const reduced=count();await sleep(350);if(count()!==reduced)throw new Error('Reduced motion autoplay');
    return {reducedMotion:true};
  })()`);
  await command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] }, autoplay.sessionId);
  await autoplay.evaluate(`(async()=>{
    const sleep=ms=>new Promise(r=>setTimeout(r,ms)), root=document.querySelector('.hero'), count=()=>root.querySelector('.hero__counter').textContent;
    root.dispatchEvent(new Event('mouseenter'));await sleep(30);const hovered=count();await sleep(350);if(count()!==hovered)throw new Error('Hover did not pause');
    root.dispatchEvent(new Event('mouseleave'));root.querySelector('.hero__action').focus();await sleep(30);const focused=count();await sleep(350);if(count()!==focused)throw new Error('Focus did not pause');
    document.activeElement.blur();await sleep(350);if(count()===focused)throw new Error('Autoplay did not resume');
    root.querySelector('[aria-label="Остановить автоматическое переключение"]').click();document.activeElement?.blur();await sleep(30);const paused=count();await sleep(350);if(count()!==paused)throw new Error('Pause button failed');
    if(!smokeDelays.includes(8000)||smokeDelays.some(ms=>ms<8000||ms>25000))throw new Error('Unexpected real carousel timer');
  })()`);
  results.push({ ...autoResult, autoplay: true, hoverPause: true, focusPause: true, pauseButton: true }); await autoplay.close();

  // Expired offers are removed from an already open page even when refreshing fails.
  currentSlides = [{ ...original[0], title: 'Предложение с коротким сроком', endsAt: new Date(Date.now() + 4000).toISOString() }, original[2]];
  const expiry = await page('/', 390);
  failSlideRefresh = true;
  await expiry.evaluate(`(async()=>{for(let i=0;i<100;i++){if(!document.querySelector('.hero__title')?.textContent.includes('коротким сроком'))return;await new Promise(r=>setTimeout(r,100))}throw new Error('Expired slide remained visible')})()`);
  await expiry.close(); failSlideRefresh = false; currentSlides = [...original];

  // SSR empty and single-slide cases, desktop without the preserved compact feature slide.
  currentSlides = [];
  const empty = await page('/', 1440); assert.equal(await empty.evaluate(`!!document.querySelector('.hero')`), false); await empty.close();
  currentSlides = [original[0]];
  const single = await page('/', 1440); assert.equal(await single.evaluate(`!!document.querySelector('.hero__controls')`), false); await single.close();
  currentSlides = [...original];

  // Cart uses authoritative API progress and changes when quantity/method changes.
  const cart = await page('/cart', 390, `localStorage.setItem('cart',${JSON.stringify(JSON.stringify({ version: 1, items: [{ product: products[0], qty: 1 }] }))});`);
  const cartResult = await cart.evaluate(`(async()=>{const wait=async f=>{for(let i=0;i<100;i++){if(f())return;await new Promise(r=>setTimeout(r,50))}throw new Error('Cart timeout')};
    await wait(()=>document.querySelector('.free-delivery__text')?.textContent.includes('осталось'));
    const store=document.querySelector('#__nuxt').__vue_app__.config.globalProperties.$pinia._s.get('cart');
    store.setQty(1,2);await wait(()=>document.querySelector('.free-delivery__text')?.textContent.includes('Бесплатная доставка'));
    const delivery=[...document.querySelectorAll('.summary__row')].find(row=>row.textContent.includes('Доставка'));
    if(!delivery.textContent.includes('Бесплатная доставка'))throw new Error('Free delivery missing from total');
    [...document.querySelectorAll('.type__item')].find(button=>button.textContent.includes('Самовывоз')).click();
    await wait(()=>!document.querySelector('.free-delivery'));return {progress:true,quantity:true,pickup:true};})()`);
  results.push(cartResult); await cart.close();

  role = 'ADMIN';
  const admin = await page('/admin/slides', 390, `localStorage.removeItem('cart');`);
  const adminResult = await admin.evaluate(`(async()=>{
    const wait=async f=>{for(let i=0;i<120;i++){if(f())return;await new Promise(r=>setTimeout(r,50))}throw new Error('Admin timeout')};
    const button=text=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===text);
    button('Создать слайд').click();await wait(()=>document.querySelector('textarea[maxlength="140"]'));
    const title=document.querySelector('textarea[maxlength="140"]');title.value='Новое объявление';title.dispatchEvent(new Event('input',{bubbles:true}));
    const text=document.querySelector('textarea[maxlength="420"]');text.value='Важная информация о работе рынка.';text.dispatchEvent(new Event('input',{bubbles:true}));
    button('Сохранить черновик').click();await wait(()=>document.querySelector('.slides__list')?.textContent.includes('Новое объявление'));
    button('Опубликовать').click();await wait(()=>!!button('Сохранить публикацию'));
    await wait(()=>document.querySelector('.slide-preview__title')?.textContent.includes('Новое объявление'));
    button('Десктоп').click();await wait(()=>document.querySelector('.slide-preview:not(.slide-preview--mobile)'));
    button('Мобильный').click();await wait(()=>document.querySelector('.slide-preview--mobile'));
    return {adminDraft:true,adminPublish:true,preview:true};
  })()`);
  results.push(adminResult); await admin.close();
  const seasons = await page('/admin/seasons', 320);
  const seasonResult = await seasons.evaluate(`(async()=>{
    const wait=async f=>{for(let i=0;i<120;i++){if(f())return;await new Promise(r=>setTimeout(r,50))}throw new Error('Season UI timeout')};
    const button=text=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===text);
    const name=document.querySelector('input[maxlength="160"]');name.value='Зимний сезон';name.dispatchEvent(new Event('input',{bubbles:true}));
    button('Создать шаблон').click();await wait(()=>document.querySelector('.seasons__templates')?.textContent.includes('Зимний сезон'));
    const checks=[...document.querySelectorAll('.seasons__product button[role="checkbox"]')];checks[0].click();checks[1].click();
    await wait(()=>document.querySelector('.seasons__selection')?.children.length===2);
    const combos=document.querySelectorAll('.seasons__assignment button[role="combobox"]');combos[1].click();
    await wait(()=>!![...document.querySelectorAll('[role="option"]')].find(item=>item.textContent.includes('Зимний сезон')));
    [...document.querySelectorAll('[role="option"]')].find(item=>item.textContent.includes('Зимний сезон')).click();
    button('Проверить назначение').click();await wait(()=>!!document.querySelector('.seasons__confirm'));
    if(document.querySelectorAll('.seasons__confirm li').length!==2)throw new Error('Assignment confirmation lost selected products');
    button('Подтвердить для 2 товаров').click();await wait(()=>!document.querySelector('.seasons__confirm'));
    if(document.documentElement.scrollWidth>innerWidth)throw new Error('Season page overflow');
    return {seasonTemplate:true,selectedProducts:true,assignmentConfirmation:true};
  })()`);
  results.push(seasonResult); await seasons.close();
  const hit = await page('/admin/hits', 320);
  await hit.evaluate(`(async()=>{
    if(document.documentElement.scrollWidth>innerWidth)throw new Error('Hit page overflow');
    if(!document.querySelector('.hits__table')?.textContent.includes('ХИТ'))throw new Error('Hit ranking missing');
    [...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Пересчитать сейчас').click();
    await new Promise(r=>setTimeout(r,500));
  })()`);
  results.push({hitRanking:true,manualRecalculation:true}); await hit.close();
  assert.ok(requests.some(request => request.path === '/api/admin/seasons/assign' && request.input?.ids.length === 2));
  assert.ok(requests.some(request => request.path === '/api/admin/hits/recalculate' && request.method === 'POST'));
  assert.ok(requests.some(request => request.path === '/api/admin/home-slides' && request.input?.published === false));
  assert.ok(requests.some(request => request.path.startsWith('/api/admin/home-slides/') && request.method === 'PATCH' && request.input?.published === true));
  await writeFile(join(artifacts, 'results.json'), JSON.stringify({ results, requests }, null, 2));
  console.log('PASS: managed hero, badge layout, expiry, cart and ADMIN smoke. Artifacts: ' + artifacts);
} finally { await browser?.close(); await web?.close(); api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); }
