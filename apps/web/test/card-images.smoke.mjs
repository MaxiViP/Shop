// Run after the web build: CATALOG_BROWSER_PATH=/usr/bin/chromium node apps/web/test/card-images.smoke.mjs
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

const artifacts = process.env.IMAGE_TEST_ARTIFACT_DIR ?? await mkdtemp(join(tmpdir(), 'korzina-card-images-'));
const categories = [{ id: 1, slug: 'fruits', name: 'Фрукты' }, { id: 2, slug: 'empty', name: 'Пустая' },
  { id: 3, slug: 'vegetables', name: 'Овощи' }, { id: 4, slug: 'greens', name: 'Зелень' }];
const fixtureCount = 240;
const products = Array.from({ length: fixtureCount }, (_, i) => ({
  id: i + 1, slug: 'fixture-' + (i + 1), name: 'Продукт с рынка ' + String(i + 1).padStart(3, '0'),
  price: 10000 + i * 100, priceStatus: 'ESTIMATED', priceQty: 1, unit: 'PIECE', step: 1, min: 1, portionQty: 1,
  category: categories[[0, 2, 3][Math.min(2, Math.floor(i / (fixtureCount / 3)))]], marketPoint: { slug: 'seller-' + i % 6, name: 'Прилавок ' + i % 6 }, images: [{url:'/images/hero/hero-0.webp?fixture='+i,alt:'Синтетическое фото'}],
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
  else if (url.pathname === '/api/home/slides') body = { serverNow: new Date().toISOString(), validUntil: new Date(Date.now() + 60_000).toISOString(),
    slides: [{ id: 1, content: 'CUSTOM', title: 'Продукты с настоящего рынка', text: 'Выбирайте товары из разных лавок в одном каталоге.',
      eyebrow: 'Прилавки рынка', image: '/images/hero/hero-0.webp', position: 'center', buttonLabel: 'В каталог', to: '/catalog', endsAt: null }] };
  else if (url.pathname === '/api/products') {
    requests.push(Object.fromEntries(url.searchParams));
    let items = products.filter(item => (!url.searchParams.get('q') || item.name.includes(url.searchParams.get('q'))) && (url.searchParams.get('tag') !== 'hit' || item.id % 2 === 1));
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
    body = { items: items.slice(offset, offset + limit).map(item => url.searchParams.get('tag') === 'hit' ? { ...item, isHit: true } : item), total: items.length, seed, page: 1, limit, pages: Math.ceil(items.length / limit),
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
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const wait = async (predicate, label) => { for (let i=0;i<900;i++) { if(await predicate()) return; await sleep(50); } throw Error(label); };
const check = (value, label) => { if(!value) throw Error(label); };
const count = () => Number(document.querySelector('[data-loaded-count]')?.dataset.loadedCount);
const images = () => [...document.querySelectorAll('.card__img img')];
const visible = () => images().filter(image => { const box=image.getBoundingClientRect();return box.bottom>0&&box.top<innerHeight; });
const ready = () => visible().every(image => image.complete&&image.naturalWidth>0);
try {
 await wait(()=>document.querySelector('#__nuxt')?.__vue_app__?.config.globalProperties.$nuxt?.isHydrating===false, 'hydration');
 const hydrationMs=performance.now();
 check(JSON.stringify([...document.querySelectorAll('.card__link')].slice(0,24).map(link=>Number(link.getAttribute('href').split('-').at(-1))))===JSON.stringify(window.catalogInitialIds),'SSR products changed');
 check(!window.catalogErrors.some(error=>/hydration|mismatch/i.test(error)), 'hydration error');
 check(document.documentElement.scrollWidth<=document.documentElement.clientWidth,'horizontal overflow');
 await wait(ready, 'first screen photos');
 await sleep(1000);
 let requested=[];
 await wait(async()=>{requested=await (await fetch('/__image-requests')).json();return requested.every(url=>performance.getEntriesByName(location.origin+url).length>0);},'initial image responses');
 await sleep(100);
 const resources=performance.getEntriesByType('resource').filter(entry=>entry.initiatorType==='img'&&entry.name.includes('?fixture='));
 const initial={hydrationMs,lcp:window.audit.lcp,cls:window.audit.cls,visible:visible().length,requested:requested.length,completed:resources.length,imageBytes:resources.reduce((sum,entry)=>sum+entry.transferSize,0),firstScreenImageMs:Math.max(...visible().map(image=>window.audit.imageLoads[image.currentSrc]??0)),eager:images().filter(image=>image.loading==='eager').length,resources:resources.map(entry=>({url:entry.name,bytes:entry.transferSize,end:entry.responseEnd,duration:entry.duration}))};
 check(initial.cls<0.1,'first-screen CLS');
 for(const image of images()){const box=image.parentElement.getBoundingClientRect();check(Math.abs(box.width-box.height)<1,'square photo area');check(getComputedStyle(image).objectFit==='contain','photo object-fit');}
 window.imageInitialDone=true;await wait(()=>window.imageScrollReady,'normal browser cache for scrolling');
 if(window.imageExpectedEager!==null){
  check(window.imageSsrBudget.eager===window.imageExpectedEager,'SSR eager image budget');
  check(window.imageSsrBudget.lazy===24-window.imageExpectedEager,'SSR native lazy image budget');
  check(images().slice(0,window.imageExpectedEager).every(image=>image.fetchPriority==='high'),'first-screen image priority');
  check(images().slice(0,window.imageExpectedEager).every(image=>image.decoding==='auto'),'preserve critical image decoding');
  check(images().slice(window.imageExpectedEager).every(image=>image.decoding==='async'),'deferred image decoding');
  check(window.imageSsrBudget.high===window.imageExpectedEager,'SSR first-screen priority budget');
 }
 if(!window.imageMeasureOnly){
 for(let page=0;page<40&&document.querySelector('.product-more__action');page++){
  const before=count();window.scrollTo(0,document.documentElement.scrollHeight);
  await wait(()=>{if(count()>before||!document.querySelector('.product-more__action'))return true;window.scrollTo(0,document.documentElement.scrollHeight);return false},'pagination');await sleep(150);
 }
 check(count()===240,'pagination lost products');
 window.scrollTo(0,0);await sleep(300);await wait(()=>document.querySelectorAll('.card').length<120,'virtualization did not bound DOM');
 }
 const appearance=[];
 for(const fraction of [0.15,0.8,0.4,0,0.95,0.25]){
  const at=performance.now();window.scrollTo(0,(document.documentElement.scrollHeight-innerHeight)*fraction);
  await sleep(100);
  await wait(()=>visible().length>0&&ready(),'photos after fast scroll');
  appearance.push(performance.now()-at);
 }
 if(!window.imageMeasureOnly&&innerWidth===390){
  window.catalogResize=768;await wait(()=>window.catalogResize===null,'tablet resize');await wait(ready,'tablet photos');
  check(document.documentElement.scrollWidth<=document.documentElement.clientWidth,'tablet overflow');
  window.catalogResize=390;await wait(()=>window.catalogResize===null,'mobile resize');await wait(ready,'mobile photos after resize');
 }
 window.scrollTo(0,0);await sleep(300);
 const frames=[];let prev=performance.now();const end=prev+2000;
 await new Promise(resolve=>{const frame=now=>{frames.push(now-prev);prev=now;window.scrollBy(0,window.imageMeasureOnly?12:80);if(now<end)requestAnimationFrame(frame);else resolve()};requestAnimationFrame(frame)});
 window.scrollTo(0,0);await sleep(200);
 let searchMs=null;
 if(!window.imageMeasureOnly){
 const input=innerWidth<768?document.querySelector('.bottom-search input'):document.querySelector('.catalog__search input');
 const started=performance.now();input.value='001';input.dispatchEvent(new Event('input',{bubbles:true}));
 await wait(()=>location.search.includes('q=001')&&count()===1,'search');await wait(ready,'searched image');await wait(()=>window.audit.photoObservers===0,'image observer cleanup after search');searchMs=performance.now()-started;
 input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));await wait(()=>!location.search.includes('q=')&&count()>=24,'clear search');await wait(ready,'clear search photos');
 document.querySelector('.product-sort__toggle').click();await wait(()=>document.querySelector('[role="menu"]'),'sort menu');[...document.querySelectorAll('[role="menuitemradio"]')].find(button=>button.textContent.includes('По названию')).click();await wait(()=>location.search.includes('sort=name')&&count()>=24,'image sorting');await wait(ready,'sorted images');
 const nuxt=document.querySelector('#__nuxt').__vue_app__.config.globalProperties.$nuxt;await nuxt.$router.replace({query:{tag:'hit'}});await wait(()=>document.querySelector('.catalog__selection')&&count()>=24,'hit filter');await wait(ready,'filtered photos');check(document.querySelectorAll('.card__ribbon--hit').length===document.querySelectorAll('.card').length,'hit filter cards');document.querySelector('.catalog__selection button').click();await wait(()=>!location.search.includes('tag=')&&count()>=24,'clear filter');await wait(ready,'clear filter photos');
 const category=document.querySelector('.categories a[href*="/catalog/fruits"]');check(category,'category link');category.click();await wait(()=>location.pathname==='/catalog/fruits'&&count()>=24,'category change');await wait(ready,'category photos');
 history.back();await wait(()=>location.pathname==='/catalog'&&count()>=24,'category back');await wait(ready,'category back photos');
 }
 check(document.documentElement.scrollWidth<=document.documentElement.clientWidth,'final horizontal overflow');
 check(!window.catalogErrors.some(error=>/hydration|mismatch/i.test(error)), 'final hydration error');
 if(window.imageExpectedEager!==null)check(window.audit.srcStates.every(state=>['eager','lazy'].includes(state.loading)&&(state.loading==='eager'||state.decoding==='async')),'CSR loading/decoding must be set before src');
 const allImages=performance.getEntriesByType('resource').filter(entry=>entry.initiatorType==='img'&&entry.name.includes('?fixture='));
 window.catalogResult={pass:true,width:innerWidth,initial,finalCls:window.audit.cls,totalImageBytes:allImages.reduce((sum,entry)=>sum+entry.transferSize,0),uniqueImagesRequested:new Set(allImages.map(entry=>entry.name)).size,appearanceMs:appearance,searchMs,frames:{count:frames.length,p95:frames.toSorted((a,b)=>a-b)[Math.floor(frames.length*.95)],over50:frames.filter(value=>value>50).length},hydrationErrors:window.catalogErrors.filter(error=>/hydration|mismatch/i.test(error))};
}catch(error){window.catalogResult={pass:false,error:String(error)}}`;

let child, proxy, base, log = '', browser;
let imageRequests = [];
let sample = 0;
const preload = `import { Server } from 'node:http'; const listen=Server.prototype.listen;
Server.prototype.listen=function(options,...args){return listen.call(this,{...options,host:'127.0.0.1',port:0},...args)};
process.stdin.resume();process.stdin.on('end',()=>process.exit());
const realFetch=globalThis.fetch;globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'?input:input.url);
if(!['127.0.0.1','localhost'].includes(url.hostname))throw new Error('External fetch blocked by catalog smoke');return realFetch(input,init)};`;
try {
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  child = spawn(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(preload), '.output/server/index.mjs'], {
    cwd: process.env.IMAGE_TEST_WEB_DIR ?? fileURLToPath(new URL('../', import.meta.url)), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NUXT_PUBLIC_API_BASE: `http://127.0.0.1:${api.address().port}/api`, NITRO_HOST: '127.0.0.1', NITRO_PORT: '0' },
  });
  child.stdout.on('data', chunk => { log += chunk; base = /Listening on (http:\/\/[^\s]+)/.exec(log)?.[1]; });
  child.stderr.on('data', chunk => { log += chunk; });
  for (let i = 0; i < 150 && !base; i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(base, 'Nitro startup: ' + log.slice(-1000));
  proxy = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/__image-requests') { res.setHeader('Content-Type','application/json');res.end(JSON.stringify(imageRequests));return; }
    if (url.pathname === '/images/hero/hero-0.webp' && url.searchParams.has('fixture') && url.searchParams.get('sample') === String(sample)) imageRequests.push(req.url);
    if (url.pathname === '/__driver') { res.setHeader('Content-Type', 'text/javascript'); res.end(driver); return; }
    try {
      const target = new URL(req.url, base);
      assert.equal(target.origin, new URL(base).origin, 'Local fixture proxy only');
      const headers = {};
      for (const name of ['if-none-match', 'if-modified-since']) if (req.headers[name]) headers[name] = req.headers[name];
      const response = await fetch(target, { headers, signal: AbortSignal.timeout(15000) });
      res.statusCode = response.status;
      for (const name of ['cache-control', 'etag', 'last-modified']) {
        const value = response.headers.get(name); if (value) res.setHeader(name, value);
      }
      res.setHeader('Content-Type', response.headers.get('content-type') ?? 'application/octet-stream');
      if (response.headers.get('content-type')?.includes('text/html')) {
        let html = await response.text();
        const imageTags = [...html.matchAll(/<img\b[^>]*\?fixture=[^>]*>/g)].map(match => match[0]);
        const imageSsrBudget = { eager: imageTags.filter(tag => tag.includes('loading="eager"')).length, lazy: imageTags.filter(tag => tag.includes('loading="lazy"')).length, high: imageTags.filter(tag => tag.includes('fetchpriority="high"')).length };
        const ids = [...new Set([...html.matchAll(/href="\/product\/fixture-(\d+)"/g)].map(match => Number(match[1])))];
        html = html.replace('<head>', `<head><script>window.catalogFixtureApi=${JSON.stringify(`http://127.0.0.1:${api.address().port}/api`)};window.catalogExpected=${fixtureCount};window.catalogInitialIds=${JSON.stringify(ids)};window.imageSsrBudget=${JSON.stringify(imageSsrBudget)};window.imageMeasureOnly=${JSON.stringify(process.env.IMAGE_TEST_MEASURE_ONLY==='1')};window.imageExpectedEager=${JSON.stringify(process.env.IMAGE_EXPECT_EAGER === 'baseline' ? null : Number(process.env.IMAGE_EXPECT_EAGER ?? 4))};performance.setResourceTimingBufferSize(5000);window.audit={lcp:0,cls:0,longTasks:[],imageLoads:{},photoObservers:0,srcStates:[]};const originalSrc=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');Object.defineProperty(HTMLImageElement.prototype,'src',{...originalSrc,set(value){if(String(value).includes('fixture='))audit.srcStates.push({loading:this.loading,decoding:this.decoding});originalSrc.set.call(this,value);}});const NativeObserver=window.IntersectionObserver;window.IntersectionObserver=class extends NativeObserver{constructor(callback,options){super(callback,options);this.photo=false;this.active=false;}observe(element){if(element instanceof HTMLImageElement&&!this.active){this.photo=true;this.active=true;audit.photoObservers++;}super.observe(element);}disconnect(){if(this.photo&&this.active){this.active=false;audit.photoObservers--;}super.disconnect();}};document.addEventListener('load',event=>{if(event.target instanceof HTMLImageElement)audit.imageLoads[event.target.currentSrc]=performance.now()},true);new PerformanceObserver(l=>{for(const e of l.getEntries())audit.lcp=e.startTime}).observe({type:'largest-contentful-paint',buffered:true});new PerformanceObserver(l=>{for(const e of l.getEntries())if(!e.hadRecentInput)audit.cls+=e.value}).observe({type:'layout-shift',buffered:true});new PerformanceObserver(l=>{for(const e of l.getEntries())audit.longTasks.push({ms:e.duration,at:e.startTime})}).observe({type:'longtask',buffered:true});window.catalogErrors=[];addEventListener('error',event=>catalogErrors.push(event.message));const warn=console.warn;console.warn=(...args)=>{catalogErrors.push(args.join(' '));warn(...args)}</script><script type="module" src="/__driver"></script>`);
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
  const widths=(process.env.IMAGE_TEST_WIDTHS??'320,390,768,1440').split(',').map(Number);
  for (const [index,item] of widths.flatMap(width=>Array.from({length:Number(process.env.IMAGE_TEST_RUNS??3)},(_,run)=>({width,path:'/catalog',mode:'images-'+width+'-'+run}))).entries()) {
    imageRequests=[];
    sample=index;
    // Separate samples also isolate decoded-image caches across viewport trials.
    for (const product of products) product.images[0].url='/images/hero/hero-0.webp?fixture='+(product.id-1)+'&sample='+sample;
    const screenshot = join(artifacts, `layout-${item.mode}-${item.width}.png`);
    const { targetId } = await command('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await command('Target.attachToTarget', { targetId, flatten: true });
    await command('Page.enable', {}, sessionId);
    await command('Runtime.enable', {}, sessionId);await command('Network.enable',{},sessionId);await command('Network.clearBrowserCache',{},sessionId);await command('Network.setCacheDisabled',{cacheDisabled:true},sessionId);if(process.env.IMAGE_TEST_NETWORK==='1')await command('Network.emulateNetworkConditions',{offline:false,latency:60,downloadThroughput:1250000,uploadThroughput:625000,connectionType:'cellular4g'},sessionId);await command('Emulation.setCPUThrottlingRate',{rate:item.width<768?4:1},sessionId);
    await command('Emulation.setDeviceMetricsOverride', { width: item.width, height: 950, deviceScaleFactor: 1, mobile: item.width < 768 }, sessionId);
    await command('Page.navigate', { url: address + item.path + '?check=' + item.mode }, sessionId);
    let result;
    for (let attempt = 0; attempt < 1200 && !result; attempt++) {
      const state = await command('Runtime.evaluate', { expression: '({result:window.catalogResult ?? null,resize:window.catalogResize ?? null,scrollReady:window.imageInitialDone&&!window.imageScrollReady})', returnByValue: true }, sessionId);
      result = state.result.value?.result;
      if (state.result.value?.scrollReady) {
        await command('Network.setCacheDisabled', { cacheDisabled: false }, sessionId);
        await command('Runtime.evaluate', { expression: 'window.imageScrollReady=true' }, sessionId);
      }
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
  await writeFile(join(artifacts, 'results.json'), JSON.stringify({ results, requests, ssr: true, conditions: {height:950,mobileCpuRate:4,desktopCpuRate:1,coldCacheBeforeScroll:true,normalCacheDuringScroll:true,network:process.env.IMAGE_TEST_NETWORK==='1'?'10 Mbps / 60 ms':'local unthrottled'} }, null, 2));

  console.log('PASS: SSR, hydration and ' + results.length + ' browser cases. Artifacts: ' + artifacts);
} finally {
  await browser?.close();
  if (child && child.exitCode === null) { const closed = once(child, 'exit'); child.stdin.end(); await closed; }
  proxy?.closeAllConnections(); await new Promise(resolve => proxy ? proxy.close(resolve) : resolve());
  api.closeAllConnections(); await new Promise(resolve => api.close(resolve));
}
