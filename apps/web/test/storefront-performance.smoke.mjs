// Built Nitro + local fixtures only; no backend, database or production requests.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openBrowser, startWeb } from './browser.mjs';

const artifacts = process.env.PERF_ARTIFACT_DIR ?? await mkdtemp(join(tmpdir(), 'storefront-perf-'));
await mkdir(artifacts, { recursive: true });
const category = { id: 1, name: 'Фрукты', slug: 'fruits' };
const items = Array.from({ length: 24 }, (_, i) => ({
  id: i + 1, slug: `fixture-${i}`, name: `Продукт ${i}`, category,
  price: 10000, priceStatus: 'SOURCE', priceQty: 1, unit: 'PIECE', step: 1, min: 1, portionQty: 1,
  images: [{ url: `/images/hero/hero-0.webp?product=${i}`, alt: 'Fixture' }], marketPoint: null,
}));
const delay = 150;
const requests = [];
const api = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  const entry = { path, start: performance.now(), browser: !!req.headers.origin };
  requests.push(entry);
  if (req.headers.origin) {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
  }
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.end(); return; }
  await new Promise(resolve => setTimeout(resolve, delay));
  let quote;
  if (path === '/api/orders/quote') {
    const chunks = [];
    try { for await (const chunk of req) chunks.push(chunk); }
    catch (error) { if (req.destroyed) return; throw error; }
    const input = JSON.parse(Buffer.concat(chunks).toString());
    const lines = input.items.map(line => ({ ...line, product: items.find(item => item.id === line.productId), status: 'AVAILABLE', lineTotal: 10000 * line.qty }));
    quote = { items: lines, subtotal: lines.reduce((sum, line) => sum + line.lineTotal, 0), valid: true, token: 'local-fixture', error: null };
  }
  const now = new Date().toISOString();
  const responses = {
    '/api/auth/me': null, '/api/categories': [category],
    '/api/home/slides': { serverNow: now, validUntil: new Date(Date.now() + 60000).toISOString(), slides: [
      { id: 1, content: 'CUSTOM', title: 'Рынок рядом', text: 'Свежие продукты с рынка.', eyebrow: 'Москва', image: '/images/hero/hero-0.webp', position: 'center', buttonLabel: 'В каталог', to: '/catalog', endsAt: null },
      { id: 2, content: 'CUSTOM', title: 'Второй слайд', text: 'Выбирайте продукты.', image: '/images/hero/hero-1.webp', position: 'center', endsAt: null },
    ] },
    '/api/products': { items, total: 24, page: 1, limit: 24, pages: 1, nextCursor: null },
    '/api/shop/settings': { deliveryEnabled: true, pickupEnabled: true },
    '/api/orders/unread': { count: 0 }, '/api/orders/quote': quote,
  };
  entry.end = performance.now();
  res.end(JSON.stringify(responses[path] ?? []));
});
const observe = `window.perfResult={lcp:[],longTasks:[],shifts:[],errors:[]};
  new PerformanceObserver(list=>{for(const e of list.getEntries())perfResult.lcp.push({time:e.startTime,size:e.size,url:e.url,tag:e.element?.tagName,class:e.element?.className})}).observe({type:'largest-contentful-paint',buffered:true});
  new PerformanceObserver(list=>{for(const e of list.getEntries())perfResult.longTasks.push({start:e.startTime,duration:e.duration})}).observe({type:'longtask',buffered:true});
  new PerformanceObserver(list=>{for(const e of list.getEntries())if(!e.hadRecentInput)perfResult.shifts.push(e.value)}).observe({type:'layout-shift',buffered:true});
  for(const name of ['warn','error']){const original=console[name];console[name]=(...args)=>{perfResult.errors.push(args.join(' '));original(...args)}}
  addEventListener('error',e=>perfResult.errors.push(e.message));`;
let web, browser;
const results = [];
const headers = {};
const flows = [];
try {
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  web = await startWeb(`http://127.0.0.1:${api.address().port}/api`);
  const html = await fetch(web.base);
  headers.html = Object.fromEntries(html.headers);
  const markup = await html.text();
  assert.ok(markup.includes('Рынок рядом') && markup.includes('Продукт 0'), 'Hero and products remain in SSR HTML');
  const css = /href="([^"]*entry\.[^"]+\.css)"/.exec(markup)?.[1];
  assert.ok(css, 'SSR entry stylesheet');
  let plain;
  for (const encoding of ['identity', 'gzip', 'br']) {
    const response = await fetch(new URL(css, web.base), { headers: { 'Accept-Encoding': encoding } });
    headers[encoding] = Object.fromEntries(response.headers);
    const decoded = Buffer.from(await response.arrayBuffer());
    if (encoding === 'identity') plain = decoded;
    else assert.deepEqual(decoded, plain, 'Compressed stylesheet decodes without changes');
    if (process.env.PERF_EXPECT_COMPRESSED === '1' && encoding !== 'identity') {
      assert.equal(response.headers.get('Content-Encoding'), encoding);
      assert.match(response.headers.get('Vary'), /Accept-Encoding/i);
    }
  }
  const image = await fetch(web.base + '/images/hero/hero-0.webp');
  headers.image = Object.fromEntries(image.headers); await image.arrayBuffer();
  await writeFile(join(artifacts, 'headers.json'), JSON.stringify(headers, null, 2));
  browser = await openBrowser(await mkdtemp(join(tmpdir(), 'storefront-browser-')));
  for (const width of [390, 1440]) for (let run = 0; run < Number(process.env.PERF_RUNS ?? 3); run++) {
    requests.length = 0;
    const { browserContextId } = await browser.command('Target.createBrowserContext');
    const { targetId } = await browser.command('Target.createTarget', { url: 'about:blank', browserContextId });
    const { sessionId } = await browser.command('Target.attachToTarget', { targetId, flatten: true });
    const command = (method, params = {}) => browser.command(method, params, sessionId);
    const evaluate = async expression => {
      const response = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      assert.ok(!response.exceptionDetails, JSON.stringify(response.exceptionDetails));
      return response.result.value;
    };
    await command('Page.enable'); await command('Network.enable');
    await command('Network.setCacheDisabled', { cacheDisabled: true });
    await command('Network.emulateNetworkConditions', { offline: false, latency: 60, downloadThroughput: 1250000, uploadThroughput: 625000 });
    await command('Emulation.setCPUThrottlingRate', { rate: width < 768 ? 4 : 1 });
    await command('Emulation.setDeviceMetricsOverride', { width, height: 950, deviceScaleFactor: 1, mobile: width < 768 });
    await command('Page.addScriptToEvaluateOnNewDocument', { source: observe });
    await command('Page.navigate', { url: web.base });
    await evaluate(`(async()=>{for(let i=0;i<500;i++){if(document.querySelector('#__nuxt')?.__vue_app__?.config.globalProperties.$nuxt?.isHydrating===false && document.querySelector('.hero__image')?.complete)return;await new Promise(r=>setTimeout(r,50))}throw Error('Hydration/image timeout')})()`);
    await new Promise(resolve => setTimeout(resolve, 2500));
    const measurement = await evaluate(`(()=>{const nav=performance.getEntriesByType('navigation')[0];return {...perfResult,ttfb:nav.responseStart-nav.requestStart,htmlTransfer:nav.transferSize,paints:performance.getEntriesByType('paint').map(e=>({name:e.name,time:e.startTime})),resources:performance.getEntriesByType('resource').map(e=>({name:e.name.replace(location.origin,''),type:e.initiatorType,start:e.startTime,end:e.responseEnd,bytes:e.transferSize,protocol:e.nextHopProtocol})),images:[...document.images].map(e=>({src:e.currentSrc,complete:e.complete,width:e.naturalWidth,box:e.getBoundingClientRect().toJSON()}))}})()`);
    assert.deepEqual(measurement.errors, [], 'Browser console/hydration errors');
    await writeFile(join(artifacts, `${width}-${run}.png`), Buffer.from((await command('Page.captureScreenshot')).data, 'base64'));
    if (process.env.PERF_EXPECT_PARALLEL === '1') {
      assert.equal(await evaluate(`document.querySelector('.hero__image').fetchPriority`), 'high');
      await evaluate(`document.querySelector('[aria-label="Следующий слайд"]').click()`);
      await new Promise(resolve => setTimeout(resolve, 500));
      assert.equal(await evaluate(`document.querySelector('.hero__image').fetchPriority`), 'auto');
    }
    const paths = ['/api/categories', '/api/products', '/api/home/slides'];
    for (const path of paths) assert.equal(requests.filter(r => r.path === path).length, 1, 'SSR payload reused: ' + path);
    if (process.env.PERF_EXPECT_PARALLEL === '1') {
      const starts = paths.map(path => requests.find(r => r.path === path).start);
      assert.ok(Math.max(...starts) - Math.min(...starts) < delay, 'Independent home requests overlap');
    }
    results.push({ width, run, ...measurement, api: [...requests] });
    if (process.env.PERF_EXPECT_PARALLEL === '1' && run === 0) {
      flows.push(await evaluate(`(async()=>{
        const wait=async(test,label)=>{for(let i=0;i<200;i++){if(test())return;await new Promise(r=>setTimeout(r,50))}throw Error(label)};
        const menu=document.querySelector('[aria-controls="mobile-menu"]');
        const visible=e=>e.getBoundingClientRect().width>0;
        if(innerWidth<768){menu.click();await wait(()=>document.querySelector('#mobile-menu'),'mobile menu')}
        const theme=()=>[...document.querySelectorAll('button[aria-label^="Тема:"]')].find(visible);
        const option=text=>[...document.querySelectorAll('[role="menuitemcheckbox"]')].find(e=>e.textContent.includes(text));
        theme().click();await wait(()=>option('Тёмная'),'theme options');option('Тёмная').click();
        await wait(()=>document.documentElement.classList.contains('dark'),'dark theme');
        theme().click();await wait(()=>option('Светлая'),'light theme option');option('Светлая').click();
        await wait(()=>!document.documentElement.classList.contains('dark'),'light theme');
        if(innerWidth<768){menu.click();await wait(()=>!document.querySelector('#mobile-menu'),'mobile menu close')}
        const before=performance.getEntriesByType('resource').length;
        const catalog=document.querySelector('.home__head a[href="/catalog"]');catalog.focus();
        await wait(()=>performance.getEntriesByType('resource').length>before,'interaction prefetch');
        catalog.click();await wait(()=>document.querySelector('.catalog .card'),'catalog navigation');
        await wait(()=>[...document.querySelectorAll('.card__img img')].filter(e=>{const b=e.getBoundingClientRect();return b.bottom>0&&b.top<innerHeight}).every(e=>e.complete&&e.naturalWidth>0),'visible catalog images');
        await wait(()=>document.querySelector('.card__add')&&!document.querySelector('.card__add').disabled,'guest cart ready');
        document.querySelector('.card__add').click();await wait(()=>document.querySelector('.card--added'),'guest cart addition');
        if(perfResult.errors.length)throw Error(perfResult.errors.join(';'));
        return {width:innerWidth,theme:true,interactionPrefetch:true,navigation:true,visibleImages:true,guestCart:true};
      })()`));
    }
    await browser.command('Target.closeTarget', { targetId });
    await browser.command('Target.disposeBrowserContext', { browserContextId });
  }
  await writeFile(join(artifacts, 'measurements.json'), JSON.stringify({ conditions: { chromium: (await browser.command('Browser.getVersion')).product, height: 950, dpr: 1, mobileCpu: 4, desktopCpu: 1, networkMbps: 10, latencyMs: 60, apiDelayMs: delay, cache: 'disabled', fixtureImages: '24 unique URLs of hero-0.webp; not production products', lighthouse: false }, results }, null, 2));
  await writeFile(join(artifacts, 'flows.json'), JSON.stringify(flows, null, 2));
  console.log(JSON.stringify(results.map(r => ({ width: r.width, ttfb: r.ttfb, fcp: r.paints.find(p => p.name === 'first-contentful-paint')?.time, lcp: r.lcp.at(-1), longTasks: r.longTasks.length, resources: r.resources.length }))));
  if (process.env.PERF_LIGHTHOUSE_CLI) {
    for (const profile of ['mobile', 'desktop']) {
      await promisify(execFile)(process.execPath, [process.env.PERF_LIGHTHOUSE_CLI, web.base,
        '--chrome-flags=--headless --disable-gpu', '--only-categories=performance,accessibility,best-practices,seo',
        '--output=json', '--output=html', `--output-path=${join(artifacts, 'lighthouse-' + profile)}`,
        ...(profile === 'desktop' ? ['--preset=desktop'] : [])], {
        env: { ...process.env, CHROME_PATH: process.env.CATALOG_BROWSER_PATH }, timeout: 180000, maxBuffer: 1024 * 1024,
      });
    }
  }
} finally { await browser?.close(); await web?.close(); api.close(); }
