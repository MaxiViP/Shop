// Run after the web build: node apps/web/test/catalog.smoke.mjs
// Local fixture API/Nitro only. Set CATALOG_BROWSER_PATH for a Chromium executable.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrowser } from './browser.mjs';

const artifacts = process.env.CATALOG_SMOKE_ARTIFACT_DIR ?? await mkdtemp(join(tmpdir(), 'korzina-catalog-smoke-'));
const categories = [{ id: 1, slug: 'fruits', name: 'Фрукты' }, { id: 2, slug: 'empty', name: 'Пустая' },
  { id: 3, slug: 'vegetables', name: 'Овощи' }, { id: 4, slug: 'greens', name: 'Зелень' }];
const fixtureCount = Number(process.env.CATALOG_SMOKE_PRODUCTS ?? 84);
const products = Array.from({ length: fixtureCount }, (_, i) => ({
  id: i + 1, slug: 'fixture-' + (i + 1), name: 'Продукт с рынка ' + String(i + 1).padStart(3, '0'),
  price: 10000 + i * 100, priceStatus: 'ESTIMATED', priceQty: 1, unit: 'PIECE', step: 1, min: 1, portionQty: 1,
  category: categories[[0, 2, 3][Math.min(2, Math.floor(i / (fixtureCount / 3)))]], marketPoint: { slug: 'seller-' + i % 6, name: 'Прилавок ' + i % 6 }, images: [],
}));
if (process.env.CATALOG_SMOKE_VARIABLE === '1') for (const [index, product] of products.entries()) {
  product.priceStatus = ['AUDITED', 'SOURCE', 'ESTIMATED'][Math.floor(index / 10) % 3];
  product.marketPoint.name = index % 7 < 3 ? 'Лавка с очень длинным названием и большим ассортиментом свежих продуктов на московском рынке' : 'Прилавок ' + index % 6;
}
categories.push(...Array.from({ length: 105 }, (_, id) => ({ id: id + 5, slug: 'category-' + id, name: 'Категория ' + id })));
const requests = [];
let staleSeed = null;
const api = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('Content-Type', 'application/json');
  if (req.headers.origin && /^http:\/\/127\.0\.0\.1:\d+$/.test(req.headers.origin)) {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin); res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'content-type'); res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  }
  if(req.method==='OPTIONS'){res.end();return;}
  let body;
  if (url.pathname === '/api/__stale-home') { staleSeed = 'next'; res.end('{}'); return; }
  if (url.pathname === '/api/auth/me') body = null;
  else if (url.pathname === '/api/categories') body = categories;
  else if (url.pathname === '/api/products') {
    requests.push(Object.fromEntries(url.searchParams));
    let items = products.filter(item => !url.searchParams.get('q') || item.name.includes(url.searchParams.get('q')));
    const selected = categories.findIndex(category => category.slug === url.searchParams.get('category'));
    if (selected >= 0) items = items.filter(item => item.category.id >= categories[selected].id);
    const cursor = url.searchParams.get('cursor') ? JSON.parse(Buffer.from(url.searchParams.get('cursor'), 'base64url').toString()) : null;
    const seed = url.searchParams.get('feed') === 'home' ? cursor?.seed ?? randomUUID() : undefined;
    if (seed && cursor && (staleSeed === 'next' || staleSeed === seed)) {
      staleSeed = seed; res.statusCode=409; res.end(JSON.stringify({ message:'Каталог обновился' })); return;
    }
    if (seed) items = items.toSorted((a, b) => {
      const hash = item => createHash('sha256').update(seed + ':' + item.id).digest('hex');
      return hash(a).localeCompare(hash(b));
    });
    else items = items.toSorted((a, b) => (selected >= 0 ? a.category.id - b.category.id : 0) ||
      (url.searchParams.get('sort') === 'price_desc' ? b.price - a.price
        : url.searchParams.get('sort') === 'newest' ? b.id - a.id
          : url.searchParams.get('sort') === 'name' ? a.name.localeCompare(b.name, 'ru') : a.price - b.price) || a.id - b.id);
    const offset = cursor?.offset ?? 0, limit = Number(url.searchParams.get('limit') ?? 24);
    body = { items: items.slice(offset, offset + limit), total: items.length, seed, page: 1, limit, pages: Math.ceil(items.length / limit),
      nextCursor: offset + limit < items.length ? Buffer.from(JSON.stringify({ offset: offset + limit, seed })).toString('base64url') : null };
  } else if (url.pathname === '/api/orders/quote') {
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const input=JSON.parse(Buffer.concat(chunks).toString());
    const items=input.items.map(line=>{const product=products.find(item=>item.id===line.productId);return {...line,product,status:'AVAILABLE',lineTotal:product.price*line.qty};});
    body={items,subtotal:items.reduce((sum,line)=>sum+line.lineTotal,0),valid:true,error:null,token:'local-quote'};
  } else if (url.pathname === '/api/settings') body = { deliveryEnabled: true, pickupEnabled: true };
  else { res.statusCode = 404; body = { message: 'Unknown local fixture route' }; }
  res.end(JSON.stringify(body));
});

const driver = String.raw`
const motion=document.createElement('style');motion.textContent='*,*::before,*::after{animation:none!important;transition:none!important}';document.head.appendChild(motion);
const wait = async (predicate, label) => { for (let i=0;i<200;i++) { if(predicate()) return; await new Promise(r=>setTimeout(r,50)); } throw new Error(label+' timeout'); };
const settle = () => new Promise(r=>setTimeout(r,100));
const check = (condition, label) => { if(!condition) throw new Error(label); };
const ids = () => [...document.querySelectorAll('.card__link')].map(link=>Number(link.getAttribute('href').split('-').at(-1)));
const loaded = () => Number(document.querySelector('[data-loaded-count]')?.dataset.loadedCount ?? ids().length);
const clickSort = () => document.querySelector('.product-sort__toggle').click();
const activeTab = () => document.querySelector('.categories [aria-current="page"]')?.textContent.trim();
const send = value => { window.catalogResult=value; };
try {
  await wait(()=>document.querySelector('#__nuxt')?.__vue_app__?.config.globalProperties.$nuxt?.isHydrating===false,'hydration');
  check(JSON.stringify(ids().slice(0,24))===JSON.stringify(window.catalogInitialIds),'SSR cards changed during hydration');
  check(!window.catalogErrors.some(error=>/hydration|mismatch/i.test(error)),'hydration warning');
  check(document.documentElement.scrollWidth<=document.documentElement.clientWidth,'horizontal page overflow');
  const mode = new URLSearchParams(location.search).get('check');
  const home = mode.startsWith('home');
  const expected = window.catalogExpected;
  const selectedSort=mode.startsWith('home-sort-')?mode.slice('home-sort-'.length):home?undefined:'price_desc';
  if(home) {
    check(!document.querySelector('.home .breadcrumbs'),'artificial home breadcrumbs');
    const row=document.querySelector('.categories');window.scrollTo(0,Math.max(0,scrollY+row.getBoundingClientRect().top-100));await settle();
  }
  {
    const fixed=document.querySelector('.categories__toggle'), strip=document.querySelector('.categories__strip'), sort=document.querySelector('.product-sort__toggle');
    const menuBox=fixed.getBoundingClientRect(), stripBox=strip.getBoundingClientRect(), sortBox=sort.getBoundingClientRect();
    check(menuBox.right<=stripBox.left&&stripBox.right<=sortBox.left,'catalog control order');
    check(Math.abs(menuBox.width-sortBox.width)<1&&Math.abs(menuBox.height-sortBox.height)<1&&menuBox.width>=44,'equal icon touch targets');
    check(!fixed.textContent.trim()&&!sort.textContent.trim()&&fixed.getAttribute('aria-label')==='Все категории'&&sort.getAttribute('aria-label')==='Сортировка','icon-only accessible controls');
    check(Math.abs(menuBox.top+menuBox.height/2-sortBox.top-sortBox.height/2)<1,'controls wrapped');
    const fixedX=menuBox.left, sortX=sortBox.left;
    check(Math.abs(strip.firstElementChild.getBoundingClientRect().left-stripBox.left)<1,'categories not aligned to the left');
    strip.scrollLeft=strip.scrollWidth;check(Math.abs(fixed.getBoundingClientRect().left-fixedX)<1&&Math.abs(sort.getBoundingClientRect().left-sortX)<1,'controls moved with strip');strip.scrollLeft=0;
    if(!home) {
    const head=document.querySelector('.catalog__head'), crumbs=head.querySelector('.breadcrumbs'), total=head.querySelector('.catalog__total');
    check(crumbs.tagName==='NAV'&&crumbs.querySelector('ol.breadcrumbs__list')&&!crumbs.contains(total),'breadcrumbs semantics');
    const countBox=total.getBoundingClientRect(), crumbBox=crumbs.querySelector('ol').getBoundingClientRect();
    check(Math.abs(countBox.top+countBox.height/2-crumbBox.top-crumbBox.height/2)<1&&Math.abs(countBox.right-head.getBoundingClientRect().right)<1,'count not aligned with breadcrumbs');
    check(head.getBoundingClientRect().top>=document.querySelector('header.header').getBoundingClientRect().bottom-1,'header covers breadcrumbs');
    check(getComputedStyle(document.querySelector('.catalog')).paddingTop==='0px','catalog top padding');
    const current=crumbs.querySelector('[aria-current="page"]'), original=current.textContent;
    current.textContent='Очень длинное название выбранной категории свежих продуктов';await settle();
    check(document.documentElement.scrollWidth<=document.documentElement.clientWidth&&current.getBoundingClientRect().right<=total.getBoundingClientRect().left,'long breadcrumb overflow');current.textContent=original;
    }
    fixed.click();await wait(()=>document.querySelector('[role="dialog"]'),'category panel');
    const dialog=document.querySelector('[role="dialog"]');
    check(document.activeElement.getAttribute('aria-label')==='Поиск категорий','category input focus');
    const body=dialog.querySelector('.categories__body');check(getComputedStyle(body).overflowY==='auto','independent category scroll');
    const bounds=dialog.getBoundingClientRect();check(bounds.bottom<=innerHeight+1&&bounds.top>=0,'category panel height');
    if(innerWidth<640)check(Math.abs(bounds.bottom-innerHeight)<2,'mobile bottom sheet');
    const input=dialog.querySelector('input');input.value='зЕЛЕнь';input.dispatchEvent(new Event('input',{bubbles:true}));
    await wait(()=>dialog.querySelectorAll('.categories__card').length===1,'local category search');
    check(dialog.querySelector('.categories__card').textContent.trim()==='Зелень','category search result');
    input.value='not-found';input.dispatchEvent(new Event('input',{bubbles:true}));await wait(()=>dialog.querySelector('.categories__empty'),'empty category result');
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    await wait(()=>fixed.getAttribute('aria-expanded')==='false','category Escape');await wait(()=>document.activeElement===fixed,'category focus return');
    const grid=document.querySelector('.grid'), before=grid.getBoundingClientRect().top;
    clickSort(); await wait(()=>document.querySelector('[role="menu"]'),'sort open');
    const panel=document.querySelector('[role="menu"]'), box=panel.getBoundingClientRect();
    check(Math.abs(grid.getBoundingClientRect().top-before)<1,'popover shifted the grid');
    check(box.left>=0 && box.right<=document.documentElement.clientWidth+1,'sort panel overflow');
    check(document.querySelector('.product-sort__toggle').getAttribute('aria-expanded')==='true','expanded state');
    check(panel.querySelectorAll('[role="menuitemradio"]').length===5,'sort choices');
    const initial=document.activeElement;
    initial.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true})); await settle();
    check(document.activeElement!==initial,'arrow-key focus');
    for(const [key,index] of [['End',4],['ArrowLeft',3],['Home',0]]) {
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true}));
      check(document.activeElement===panel.querySelectorAll('button')[index],'keyboard '+key);
    }
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    await wait(()=>document.querySelector('.product-sort__toggle').getAttribute('aria-expanded')==='false','Escape close');
    clickSort(); await wait(()=>document.querySelector('[role="menu"]'),'reopen');
    document.querySelector('h1').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerType:'mouse'}));
    document.querySelector('h1').dispatchEvent(new MouseEvent('click',{bubbles:true}));
    await wait(()=>document.querySelector('.product-sort__toggle').getAttribute('aria-expanded')==='false','outside close');
    if(selectedSort) {
      clickSort(); await wait(()=>document.querySelector('[role="menu"]'),'choose open');
      const label={price_asc:'Сначала дешевле',price_desc:'Сначала дороже',name:'По названию',newest:'Новинки'}[selectedSort];
      [...document.querySelectorAll('[role="menuitemradio"]')].find(button=>button.textContent.includes(label)).click();
      await wait(()=>location.search.includes(selectedSort) && document.querySelector('.product-sort__toggle').getAttribute('aria-expanded')==='false' && ids().length>=24,'sort selection');
      const descending=['price_desc','newest'].includes(selectedSort);
      check(ids()[0]===(descending?(mode==='layout'?expected/3:expected):1),'sort reset');
      if(home)check([...document.querySelectorAll('.categories__strip a')].every(link=>link.href.includes('sort='+selectedSort)),'home categories lost sorting');
    }
  }
  const route=location.pathname+location.search;
  if(mode==='home-change') {
    await fetch(window.catalogFixtureApi+'/__stale-home');window.scrollTo(0,document.documentElement.scrollHeight);
    await wait(()=>[...document.querySelectorAll('.product-more__error button')].some(button=>button.textContent==='Обновить витрину'),'changed home catalogue banner');
    check(loaded()===24,'changed home appended stale ranks');
    document.querySelector('.product-more__error button').click();
    await wait(()=>loaded()===24&&!document.querySelector('.product-more__error'),'home refresh recovery');
  }
  if(!home&&innerWidth<768) {
    await wait(()=>document.querySelector('.card__add')&&!document.querySelector('.card__add').disabled,'cart restoration');
    document.querySelector('.card__add').click();window.scrollTo(0,700);
    await wait(()=>document.querySelector('.floating-cart-anchor--visible'),'floating mobile cart');
    await settle();const sortBox=document.querySelector('.product-sort__toggle').getBoundingClientRect();
    check(document.querySelector('.product-sort__toggle').contains(document.elementFromPoint(sortBox.left+sortBox.width/2,sortBox.top+sortBox.height/2)),'floating cart covers sorting');
    document.querySelector('.categories__toggle').click();await wait(()=>document.querySelector('[role="dialog"]'),'sheet over cart');
    const dialog=document.querySelector('[role="dialog"]'), cart=document.querySelector('.floating-cart-anchor');
    check(Number(getComputedStyle(dialog).zIndex)>Number(getComputedStyle(cart).zIndex),'cart covers category sheet');
    const box=dialog.getBoundingClientRect();check(dialog.contains(document.elementFromPoint(box.left+box.width/2,box.top+40)),'sheet is not topmost');
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await wait(()=>!document.querySelector('[role="dialog"]'),'sheet close over cart');
  }
  for(let page=0;page<80 && document.querySelector('.product-more__action');page++) {
    const count=loaded();
    window.scrollTo(0,document.documentElement.scrollHeight);
    await wait(()=>{if(loaded()>count || !document.querySelector('.product-more__action'))return true;window.scrollTo(0,document.documentElement.scrollHeight);return false},'automatic next page');
  }
  check(loaded()===expected,'infinite feed omitted products');
  check(new Set(ids()).size===ids().length,'duplicate mounted cards');
  if(expected>120)check(ids().length<120,'long feed retained too many DOM cards');
  check(!document.querySelector('.product-more__action'),'feed did not end');
  check(location.pathname+location.search===route,'scroll changed route/history');
  if(expected>120) {
    const positions = [0.85,0.6,0.4,0.2,0.05,0.4,0.7,0.2];
    for(const fraction of positions) {
      window.scrollTo(0,(document.documentElement.scrollHeight-innerHeight)*fraction);
      await settle();await settle();
      const anchor=[...document.querySelectorAll('.card')].find(card=>{const box=card.getBoundingClientRect();return box.top>=180&&box.top<innerHeight-100});
      check(anchor,'blank viewport after reverse virtual scroll');
      const anchorId=anchor.querySelector('.card__link').getAttribute('href'), anchorTop=anchor.getBoundingClientRect().top;
      await settle();await settle();
      const current=[...document.querySelectorAll('.card')].find(card=>card.querySelector('.card__link').getAttribute('href')===anchorId);
      check(current&&Math.abs(current.getBoundingClientRect().top-anchorTop)<2,'virtual scroll anchor jumped: '+anchorId+' '+anchorTop+' -> '+current?.getBoundingClientRect().top);
      check(new Set(ids()).size===ids().length,'duplicate virtual cards on reverse scroll');
      check(ids().length<120,'reverse scroll retained too many DOM cards');
      check(loaded()===expected,'reverse scroll discarded loaded data');
      check(location.pathname+location.search===route,'reverse scroll changed URL');
    }
    if(innerWidth===390) {
      const card=[...document.querySelectorAll('.card')].find(card=>{const box=card.getBoundingClientRect();return box.top>=180&&box.top<innerHeight-100});
      const href=card.querySelector('.card__link').getAttribute('href');
      window.catalogResize=768;await wait(()=>window.catalogResize===null,'resize to tablet');await settle();await settle();
      const resized=[...document.querySelectorAll('.card')].find(el=>el.querySelector('.card__link').getAttribute('href')===href);
      check(resized&&resized.getBoundingClientRect().bottom>100&&resized.getBoundingClientRect().top<innerHeight,'virtual scroll lost the visible product on resize: '+href);
      window.catalogResize=390;await wait(()=>window.catalogResize===null,'resize back to mobile');await settle();await settle();
      check(document.documentElement.scrollWidth<=document.documentElement.clientWidth,'resize overflow');
    }
  }
  if(mode==='layout') {
    for(const [slug,label] of [['vegetables','Овощи'],['greens','Зелень'],['fruits','Фрукты']]) {
      const grid=document.querySelector('[data-category="'+slug+'"] .grid');
      const nav=document.querySelector('.catalog__navigation');
      const anchor=parseFloat(getComputedStyle(nav).top)+nav.offsetHeight+4;
      window.scrollTo(0,window.scrollY+grid.getBoundingClientRect().top-anchor);
      await wait(()=>activeTab()===label,'active category '+label);
      const strip=document.querySelector('.categories__strip'), tab=strip.querySelector('[aria-current="page"]');
      await wait(()=>{const outer=strip.getBoundingClientRect(),inner=tab.getBoundingClientRect();return inner.left>=outer.left-1&&inner.right<=outer.right+1},'active tab hidden');
    }
    const count=loaded();
    document.querySelector('.categories a[href*="/catalog/vegetables"]').click();
    await wait(()=>location.pathname==='/catalog/vegetables' && document.querySelector('[data-category="vegetables"]') && !document.querySelector('[data-category="fruits"]'),'manual category');
    check(loaded()<count,'manual category did not reset pagination');
    history.back(); await wait(()=>location.pathname==='/catalog/fruits' && document.querySelector('[data-category="fruits"]'),'back history');
  }
  if(selectedSort&&mode!=='layout') {
    const descending=['price_desc','newest'].includes(selectedSort);
    check(ids().every((id,index,values)=>index===0 || (descending?values[index-1]>id:values[index-1]<id)),'sort changed between pages');
  }
  window.scrollTo(0,0); await settle();
  if(mode==='layout') { clickSort(); await wait(()=>document.querySelector('[role="menu"]'),'screenshot panel'); }
  send({pass:true,width:innerWidth,mode,cards:expected,hydration:true,overflow:false,clientWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth});
} catch(error) { send({pass:false,width:innerWidth,error:String(error),errors:window.catalogErrors,
  tabs:[...document.querySelectorAll('.categories a')].map(tab=>({text:tab.textContent.trim(),current:tab.getAttribute('aria-current')})),
  scrollY,clientWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,
  groups:[...document.querySelectorAll('[data-category]')].map(section=>({category:section.dataset.category,top:section.querySelector('.grid').getBoundingClientRect().top,bottom:section.querySelector('.grid').getBoundingClientRect().bottom}))}); }
`;

let child, proxy, base, log = '', browser;
const preload = `import { Server } from 'node:http'; const listen=Server.prototype.listen;
Server.prototype.listen=function(options,...args){return listen.call(this,{...options,host:'127.0.0.1',port:0},...args)};
process.stdin.resume();process.stdin.on('end',()=>process.exit());
const realFetch=globalThis.fetch;globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'?input:input.url);
if(!['127.0.0.1','localhost'].includes(url.hostname))throw new Error('External fetch blocked by catalog smoke');return realFetch(input,init)};`;
try {
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  child = spawn(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(preload), '.output/server/index.mjs'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NUXT_PUBLIC_API_BASE: `http://127.0.0.1:${api.address().port}/api`, NITRO_HOST: '127.0.0.1', NITRO_PORT: '0' },
  });
  child.stdout.on('data', chunk => { log += chunk; base = /Listening on (http:\/\/[^\s]+)/.exec(log)?.[1]; });
  child.stderr.on('data', chunk => { log += chunk; });
  for (let i = 0; i < 150 && !base; i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(base, 'Nitro startup: ' + log.slice(-1000));
  proxy = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/__driver') { res.setHeader('Content-Type', 'text/javascript'); res.end(driver); return; }
    try {
      const response = await fetch(new URL(req.url, base), { signal: AbortSignal.timeout(15000) });
      res.statusCode = response.status;
      res.setHeader('Content-Type', response.headers.get('content-type') ?? 'application/octet-stream');
      if (response.headers.get('content-type')?.includes('text/html')) {
        let html = await response.text();
        const ids = [...new Set([...html.matchAll(/href="\/product\/fixture-(\d+)"/g)].map(match => Number(match[1])))];
        html = html.replace('<head>', `<head><script>window.catalogFixtureApi=${JSON.stringify(`http://127.0.0.1:${api.address().port}/api`)};window.catalogExpected=${fixtureCount};window.catalogInitialIds=${JSON.stringify(ids)};window.catalogErrors=[];addEventListener('error',event=>catalogErrors.push(event.message));const warn=console.warn;console.warn=(...args)=>{catalogErrors.push(args.join(' '));warn(...args)}</script><script type="module" src="/__driver"></script>`);
        res.end(html);
      } else res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) { res.statusCode = 500; res.end(String(error)); }
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const address = `http://127.0.0.1:${proxy.address().port}`;
  for (const path of ['/', '/catalog', '/catalog/fruits', ...['price_asc','price_desc','name','newest'].map(sort=>'/?sort='+sort)]) {
    const html = await (await fetch(new URL(path, base))).text();
    assert.equal(new Set([...html.matchAll(/href="\/product\/fixture-(\d+)"/g)].map(match => match[1])).size, 24, path + ' SSR first page');
    assert.match(html, /<script[^>]*id="__NUXT_DATA__"/); assert.match(html, /rel="canonical"/);
    if (path === '/') { assert.ok(!html.includes('market-about')); assert.ok(html.includes('hero__slide')); }
    const query=new URL(path,base).searchParams;
    if(query.has('sort')) {
      const first=Number([...html.matchAll(/href="\/product\/fixture-(\d+)"/g)][0][1]);
      assert.equal(first,['price_desc','newest'].includes(query.get('sort'))?fixtureCount:1,'home SSR sorting');
    }
    await writeFile(join(artifacts, 'ssr-' + (path === '/' ? 'home' : query.has('sort')?'home-'+query.get('sort'):path.replaceAll('/', '-')) + '.html'), html);
  }
  const results = [];
  const profile = await mkdtemp(join(artifacts, 'browser-'));
  browser = await openBrowser(profile);
  const command = browser.command;
  for (const [index, item] of [...[320, 360, 390, 768, 1024, 1440].map(width => ({ width, mode: 'layout', path: '/catalog/fruits' })),
    ...[320,360,390,768,1024,1440].map(width=>({width,mode:'home',path:'/'})),
    ...['price_asc','price_desc','name','newest'].map(sort=>({width:390,mode:'home-sort-'+sort,path:'/'})),
    { width: 390, mode: 'all', path: '/catalog' }, { width: 390, mode: 'home-change', path: '/' }]
    .filter(item => !process.env.CATALOG_SMOKE_WIDTH || item.width === Number(process.env.CATALOG_SMOKE_WIDTH)).entries()) {
    const screenshot = join(artifacts, `layout-${item.mode}-${item.width}.png`);
    const { targetId } = await command('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await command('Target.attachToTarget', { targetId, flatten: true });
    await command('Page.enable', {}, sessionId);
    await command('Runtime.enable', {}, sessionId);
    await command('Emulation.setDeviceMetricsOverride', { width: item.width, height: 950, deviceScaleFactor: 1, mobile: item.width < 768 }, sessionId);
    await command('Page.navigate', { url: address + item.path + '?check=' + item.mode }, sessionId);
    let result;
    for (let attempt = 0; attempt < 300 && !result; attempt++) {
      const state = await command('Runtime.evaluate', { expression: '({result:window.catalogResult ?? null,resize:window.catalogResize ?? null})', returnByValue: true }, sessionId);
      result = state.result.value?.result;
      if (state.result.value?.resize) {
        const width=state.result.value.resize;
        await command('Emulation.setDeviceMetricsOverride', { width, height: 950, deviceScaleFactor: 1, mobile: width < 768 }, sessionId);
        await command('Runtime.evaluate', { expression: 'window.catalogResize=null' }, sessionId);
      }
      if (!result) await new Promise(resolve => setTimeout(resolve, 100));
    }
    const picture = await command('Page.captureScreenshot', { format: 'png' }, sessionId);
    await writeFile(screenshot, Buffer.from(picture.data, 'base64'));
    const dom = await command('Runtime.evaluate', { expression: 'document.documentElement.outerHTML', returnByValue: true }, sessionId);
    await writeFile(join(artifacts, `browser-${index}.html`), dom.result.value);
    await command('Target.closeTarget', { targetId });
    assert.ok(result, 'Browser did not finish: ' + screenshot);
    console.log(JSON.stringify(result)); assert.equal(result.pass, true, JSON.stringify(result));
    assert.equal(result.width, item.width); results.push(result);
  }
  await writeFile(join(artifacts, 'results.json'), JSON.stringify({ results, requests, ssr: true }, null, 2));

  console.log('PASS: SSR, hydration and ' + results.length + ' browser cases. Artifacts: ' + artifacts);
} finally {
  await browser?.close();
  if (child && child.exitCode === null) { const closed = once(child, 'exit'); child.stdin.end(); await closed; }
  proxy?.closeAllConnections(); await new Promise(resolve => proxy ? proxy.close(resolve) : resolve());
  api.closeAllConnections(); await new Promise(resolve => api.close(resolve));
}
