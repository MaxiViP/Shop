// Run after the web build: node apps/web/test/map.smoke.mjs
// All positions below belong to local test fixtures, never to the real market.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBrowser, startWeb } from './browser.mjs';

const artifacts = process.env.MAP_SMOKE_ARTIFACT_DIR ?? await mkdtemp(join(tmpdir(), 'korzina-map-smoke-'));
let tick = Date.parse('2026-10-08T00:00:00Z');
const basePoint = { unitNumber: null, description: null, sampleAssortment: null, photoUrl: null, floor: 2,
  mapWidth: null, mapHeight: null, mapColor: null, isOurPoint: false, ourLabel: null, isPublished: true, sortOrder: 0,
  createdAt: new Date(tick).toISOString(), updatedAt: new Date(tick).toISOString() };
let points = [{ ...basePoint, id: 1, slug: 'test-shop', name: 'Тестовая лавка', kind: 'STALL', mapX: 30, mapY: 40 },
  { ...basePoint, id: 2, slug: 'test-neighbour', name: 'Соседняя лавка', kind: 'STALL', mapX: 34, mapY: 40 },
  { ...basePoint, id: 3, slug: 'test-entry', name: 'Вход', kind: 'ENTRY', mapX: 65, mapY: 20 }];
const layouts = new Map([[2, { floor: 2, escalator: null, updatedAt: new Date(tick).toISOString() }]]);
const mutations = [];
const api = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('Content-Type', 'application/json');
  if (req.headers.origin && /^http:\/\/127\.0\.0\.1:\d+$/.test(req.headers.origin)) {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin); res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'content-type'); res.setHeader('Access-Control-Allow-Methods', 'GET,PATCH,POST,OPTIONS');
  }
  if (req.method === 'OPTIONS') { res.end(); return; }
  if (url.searchParams.get('floor') === '1' || url.pathname === '/api/admin/market-map/layouts/1') await new Promise(resolve=>setTimeout(resolve,250));
  let body;
  if (req.method === 'PATCH') {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString()); mutations.push({ path: url.pathname, input });
    const pointId = /^\/api\/admin\/market-map\/points\/(\d+)$/.exec(url.pathname)?.[1];
    if (pointId) {
      const old = points.find(point => point.id === Number(pointId));
      if (input.expectedUpdatedAt !== old.updatedAt) { res.statusCode = 409; body = { message: 'Version conflict' }; }
      else {
        delete input.expectedUpdatedAt;
        if (input.isOurPoint) points = points.map(point => point.id !== old.id && point.floor === old.floor && point.isOurPoint
          ? { ...point, isOurPoint: false, updatedAt: new Date(++tick).toISOString() } : point);
        body = { ...old, ...input, updatedAt: new Date(++tick).toISOString() }; points = points.map(point => point.id === body.id ? body : point);
      }
    } else {
      const floor = Number(url.pathname.split('/').at(-1)); body = { floor, escalator: input.escalator, updatedAt: new Date(++tick).toISOString() }; layouts.set(floor, body);
    }
  } else if (url.pathname === '/api/auth/me') body = { id: 1, role: 'ADMIN', phone: '+79990000000', name: 'Local fixture', verifiedAt: '2026-10-08T00:00:00Z' };
  else if (url.pathname === '/api/admin/market-map/points' || url.pathname === '/api/market-map') body = points.filter(point => point.floor === Number(url.searchParams.get('floor') ?? 2));
  else if (url.pathname.startsWith('/api/admin/market-map/layouts/')) { const floor=Number(url.pathname.split('/').at(-1)); body = layouts.get(floor) ?? { floor, escalator: null, updatedAt: null }; }
  else if (url.pathname === '/api/market-map/layouts/floors') body = [1, 2];
  else if (url.pathname.startsWith('/api/market-map/layout/')) { const layout = layouts.get(Number(url.pathname.split('/').at(-1))); body = { ...layout, escalator: layout?.escalator?.published ? layout.escalator : null }; }
  else if (url.pathname === '/api/categories' || url.pathname.startsWith('/api/staff/orders')) body = [];
  else if (url.pathname === '/api/favorites') body = { items: [] };
  else if (url.pathname === '/api/notifications') body = { scope: null, events: [], hasMore: false };
  else { res.statusCode = 404; body = { message: 'Unknown fixture route' }; }
  res.end(JSON.stringify(body));
});

const driver = String.raw`
const style=document.createElement('style');style.textContent='*,*::before,*::after{animation:none!important;transition:none!important}';document.head.appendChild(style);
const wait=async(predicate,label)=>{for(let i=0;i<250;i++){if(predicate())return;await new Promise(r=>setTimeout(r,40))}throw new Error(label+' timeout')};
const check=(value,label)=>{if(!value)throw new Error(label)};
const button=text=>[...document.querySelectorAll('button')].find(el=>el.textContent.trim()===text);
const field=label=>document.querySelector('input[aria-label="'+label+'"]');
const input=(label,value)=>{const el=field(label);el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}))};
const switchFor=label=>{const text=[...document.querySelectorAll('label')].find(el=>el.textContent.trim()===label);return text?document.getElementById(text.htmlFor):[...document.querySelectorAll('[role="switch"]')].find(el=>el.parentElement.textContent.includes(label))};
const point=()=>document.querySelector('.map__point[aria-label^="Тестовая лавка"]');
const rect=()=>point().querySelector('.map__hit');
const dimensions=()=>({width:Number(rect().getAttribute('width')),height:Number(rect().getAttribute('height'))});
const cancel=async()=>{button('Отменить').click();await wait(()=>button('Подтвердить'),'discard dialog');button('Подтвердить').click();await wait(()=>!document.querySelector('[role="dialog"]'),'discard close')};
const requestDrag=async(element,dx,dy)=>{
  document.querySelector('.map__viewport').scrollIntoView({block:'center'});await new Promise(r=>setTimeout(r,60));
  const box=element.getBoundingClientRect(), svg=document.querySelector('.map__drawing'), scale=svg.getScreenCTM().a;
  window.mapAction={x:box.left+box.width/2,y:box.top+box.height/2,dx:dx*scale,dy:dy*scale};
  await wait(()=>window.mapAction===null,'trusted pointer drag');await new Promise(r=>setTimeout(r,70));
};
const requestClick=async element=>{
  const box=element.getBoundingClientRect();window.mapAction={x:box.left+box.width/2,y:box.top+box.height/2,dx:0,dy:0};
  await wait(()=>window.mapAction===null,'trusted menu click');
};
try {
  await wait(()=>document.querySelector('#__nuxt')?.__vue_app__?.config.globalProperties.$nuxt?.isHydrating===false,'hydration');
  check(!window.mapErrors.some(error=>/hydration|mismatch/i.test(error)),'hydration mismatch');
  const mode=new URLSearchParams(location.search).get('check');
  check(document.documentElement.scrollWidth<=document.documentElement.clientWidth,'page overflow');
  if(mode==='empty-floor') {
    check(!document.querySelector('.map__drawing image'),'unrelated floor SVG');
    check(!document.querySelector('.map__point'),'invented first-floor point');
    check(!button('Где мы?'),'unassigned locator');
    check(!document.querySelector('.map__escalator')&&!document.querySelector('.map__legacy-escalator'),'invented first-floor landmark');
    check(document.querySelector('.map').textContent.includes('Фоновая схема этого этажа ещё не добавлена'),'missing floor notice');
  } else if(mode.startsWith('admin')) {
    point().dispatchEvent(new MouseEvent('click',{bubbles:true}));await wait(()=>field('Ширина области')?.value==='80'||field('Ширина области')?.value==='120','select point');
    const boundaries=switchFor('Показать границы точек');boundaries.click();await wait(()=>document.querySelectorAll('[data-handle]').length===8,'eight handles');
    check(document.querySelectorAll('.map__point--boundary').length===3,'all actual boundaries');
    if(mode==='admin-reload') {
      check(dimensions().width===120&&dimensions().height===140,'reloaded hit dimensions');
      check(point().classList.contains('map__point--ours')&&point().textContent.includes('Мы здесь!'),'reloaded primary point');
      check(field('HEX-цвет точки').value==='','reloaded colour reset');
      check(document.querySelectorAll('.map__escalator-track').length===2&&!document.querySelector('.map__legacy-escalator'),'reloaded landmark');
      check(!document.querySelector('.map-admin__dirty'),'reload produced an unsaved draft');
    }
    if(mode==='admin-floor') {
      document.querySelector('.map-admin__header [role="combobox"]').click();await wait(()=>document.querySelector('[role="option"]'),'floor choices');
      await requestClick([...document.querySelectorAll('[role="option"]')].find(option=>option.textContent.trim()==='1 этаж'));
      await wait(()=>document.querySelector('.map-admin__form').inert,'floor transition locks form');
      const field=document.querySelector('.map-admin__form input');field.focus();check(document.activeElement!==field,'pending floor accepts edits');
      await wait(()=>!document.querySelector('.map-admin__form').inert&&document.querySelector('.map__floor').textContent==='1 этаж','first floor loaded');
      check(!document.querySelector('.map__drawing image')&&!document.querySelector('.map__point'),'first floor reused another scheme');
      check(!document.querySelector('.map-admin__dirty'),'floor transition created a draft');
    }
    if(mode==='admin-edit') {
      check(document.querySelector('.map__warning'),'overlap warning');
      const neighbour=document.querySelector('.map__point[aria-label^="Соседняя лавка"]').getAttribute('transform');
      for(const target of [200,300]) {
        while(Number(document.querySelector('.map__scale').textContent.replace('%',''))<target){document.querySelector('button[aria-label="Увеличить карту"]').click();await new Promise(r=>setTimeout(r,50))}
        const view=document.querySelector('.map__viewport'), scale=document.querySelector('.map__drawing').getScreenCTM().a;
        view.scrollLeft=360*scale-view.clientWidth/2;view.scrollTop=584*scale-view.clientHeight/2;
        for(const handle of ['nw','n','ne','e','se','s','sw','w']) {
          const before=dimensions();await requestDrag(document.querySelector('[data-handle="'+handle+'"]'),10,10);
          const after=dimensions();check(Math.abs(after.width-(before.width+(handle.includes('w')?-10:handle.includes('e')?10:0)))<.02,'width '+handle+' at '+target);
          check(Math.abs(after.height-(before.height+(handle.includes('n')?-10:handle.includes('s')?10:0)))<.02,'height '+handle+' at '+target);
          check(document.querySelector('.map__point[aria-label^="Соседняя лавка"]').getAttribute('transform')===neighbour,'neighbour changed');
          await cancel();
        }
      }
      const beforeX=Number(field('X области').value),beforeY=Number(field('Y области').value);
      await requestDrag(rect(),20,30);check(Math.abs(Number(field('X области').value)-beforeX-20)<.02,'area move X');check(Math.abs(Number(field('Y области').value)-beforeY-30)<.02,'area move Y');await cancel();
      input('Ширина области','120');input('Высота области','140');input('HEX-цвет точки','#FFAA00');switchFor('Наша точка').click();
      await wait(()=>!button('Сохранить точку').disabled,'point save enabled');button('Сохранить точку').click();await wait(()=>!document.querySelector('.map-admin__dirty')&&!button('Добавить точку').disabled,'point save');
      check(point().classList.contains('map__point--ours'),'ours preview');check(point().textContent.includes('Мы здесь!'),'default label');
      button('Сбросить цвет').click();await wait(()=>!button('Сохранить точку').disabled,'colour reset enabled');button('Сохранить точку').click();await wait(()=>!document.querySelector('.map-admin__dirty')&&!button('Добавить точку').disabled,'colour reset save');
      document.querySelector('.map__point[aria-label^="Соседняя лавка"]').dispatchEvent(new MouseEvent('click',{bubbles:true}));
      await wait(()=>document.querySelector('.map-admin__form input').value==='Соседняя лавка','select next primary');
      switchFor('Наша точка').click();await wait(()=>!button('Сохранить точку').disabled,'new primary save enabled');button('Сохранить точку').click();await wait(()=>!document.querySelector('.map-admin__dirty')&&!button('Добавить точку').disabled,'primary reassignment');
      point().dispatchEvent(new MouseEvent('click',{bubbles:true}));await wait(()=>document.querySelector('.map-admin__form input').value==='Тестовая лавка','return to former primary');
      check(switchFor('Наша точка').getAttribute('aria-checked')==='false','former primary still selected');
      switchFor('Наша точка').click();await wait(()=>!button('Сохранить точку').disabled,'former primary save enabled');button('Сохранить точку').click();await wait(()=>!document.querySelector('.map-admin__dirty')&&!button('Добавить точку').disabled,'former primary version refresh');
      check(!document.querySelector('.map-admin').textContent.includes('Version conflict'),'stale former-primary version');
      button('Настроить длинный эскалатор').click();await wait(()=>document.querySelector('.map-admin__landmark input'),'landmark form');check(!document.querySelector('.map__escalator'),'invented landmark coordinates');
      const esc=document.querySelector('.map-admin__landmark');const esInput=[...esc.querySelectorAll('input')];
      esInput[0].value='600';esInput[0].dispatchEvent(new Event('input',{bubbles:true}));esInput[1].value='700';esInput[1].dispatchEvent(new Event('input',{bubbles:true}));
      switchFor('Показывать эскалатор покупателям').click();await wait(()=>document.querySelector('.map__escalator'),'landmark preview');
      check(document.querySelectorAll('.map__escalator-track').length===2,'parallel escalator tracks');check(!document.querySelector('.map__legacy-escalator'),'duplicate landmark');
      button('Сохранить эскалатор').click();await wait(()=>!document.querySelector('.map-admin__landmark .map-admin__dirty'),'landmark save');
      window.mapReload=true;
    }
  } else {
    check(!document.querySelector('[data-handle]')&&!document.querySelector('.map__point--boundary')&&!document.querySelector('.map__warning'),'public editor controls');
    check(point().textContent.includes('Мы здесь!'),'ours public label');
    check(dimensions().width===120&&dimensions().height===140,'saved hit bounds');
    check(document.querySelectorAll('.map__escalator-track').length===2,'public escalator');
    check([...document.querySelectorAll('.map text')].filter(text=>text.textContent==='Эскалатор').length===1,'duplicate escalator label');
    button('Где мы?').click();await wait(()=>Number(document.querySelector('.map__scale').textContent.replace('%',''))>=250,'locator zoom');
    check(point().classList.contains('map__point--selected'),'locator highlight');
    document.documentElement.classList.toggle('dark');check(point().textContent.includes('Мы здесь!'),'theme label');
  }
  check(document.documentElement.scrollWidth<=document.documentElement.clientWidth,'final page overflow');
  window.mapResult={pass:true,width:innerWidth,mode,handles:mode.startsWith('admin')?8:0,hydration:true};
} catch(error){window.mapResult={pass:false,width:innerWidth,error:String(error),errors:window.mapErrors,body:document.body.textContent.slice(-800)}}
`;

let web, proxy, browser;
try {
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  web = await startWeb(`http://127.0.0.1:${api.address().port}/api`);
  proxy = createServer(async (req, res) => {
    if (req.url === '/__map_driver') { res.setHeader('Content-Type', 'text/javascript'); res.end(driver); return; }
    const response = await fetch(new URL(req.url, web.base)); res.statusCode = response.status; res.setHeader('Content-Type', response.headers.get('content-type') ?? 'application/octet-stream');
    if (response.headers.get('content-type')?.includes('text/html')) {
      let html = await response.text(); html = html.replace('<head>', `<head><script>window.mapErrors=[];addEventListener('error',e=>mapErrors.push(e.message));const warn=console.warn;console.warn=(...args)=>{mapErrors.push(args.join(' '));warn(...args)}</script><script type="module" src="/__map_driver"></script>`); res.end(html);
    } else res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const address = `http://127.0.0.1:${proxy.address().port}`;
  browser = await openBrowser(await mkdtemp(join(artifacts, 'browser-'))); const command = browser.command;
  const results = [];
  const cases = [{ width: 390, mode: 'admin-edit', path: '/admin/market-map' },
    { width: 390, mode: 'empty-floor', path: '/market-map?floor=1' },
    { width: 390, mode: 'admin-floor', path: '/admin/market-map' },
    ...[320, 360, 390, 768, 1024, 1440].map(width => ({ width, mode: 'public', path: '/market-map' })),
    ...[320, 360, 768, 1024, 1440].map(width => ({ width, mode: 'admin-view', path: '/admin/market-map' }))];
  for (const item of cases) {
    const { targetId } = await command('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await command('Target.attachToTarget', { targetId, flatten: true });
    await command('Page.enable', {}, sessionId); await command('Runtime.enable', {}, sessionId);
    await command('Emulation.setDeviceMetricsOverride', { width: item.width, height: 950, deviceScaleFactor: 1, mobile: item.width < 768 }, sessionId);
    await command('Page.navigate', { url: address + item.path + (item.path.includes('?') ? '&' : '?') + 'check=' + item.mode }, sessionId);
    let result;
    for (let attempt = 0; attempt < 1500 && !result; attempt++) {
      const state = await command('Runtime.evaluate', { expression: '({result:window.mapResult??null,action:window.mapAction??null})', returnByValue: true }, sessionId);
      const value = state.result.value; result = value?.result;
      if (value?.action) {
        const { x, y, dx, dy } = value.action;
        await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sessionId);
        await command('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sessionId);
        await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + dx, y: y + dy, button: 'left', buttons: 1 }, sessionId);
        await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + dx, y: y + dy, button: 'left', clickCount: 1 }, sessionId);
        await command('Runtime.evaluate', { expression: 'window.mapAction=null' }, sessionId);
      }
      if (!result) await new Promise(resolve => setTimeout(resolve, 40));
    }
    if (item.mode === 'admin-edit' && result?.pass) {
      console.log(JSON.stringify(result)); results.push(result);
      await command('Runtime.evaluate', { expression: "history.replaceState(history.state,'',location.pathname+'?check=admin-reload');window.mapResult=null" }, sessionId);
      await command('Page.reload', { ignoreCache: true }, sessionId);
      result = null;
      for (let attempt = 0; attempt < 300 && !result; attempt++) {
        result = (await command('Runtime.evaluate', { expression: 'window.mapResult??null', returnByValue: true }, sessionId)).result.value;
        if (!result) await new Promise(resolve => setTimeout(resolve, 40));
      }
    }
    const picture = await command('Page.captureScreenshot', { format: 'png' }, sessionId); await writeFile(join(artifacts, `${item.mode}-${item.width}.png`), Buffer.from(picture.data, 'base64'));
    const dom = await command('Runtime.evaluate', { expression: 'document.documentElement.outerHTML', returnByValue: true }, sessionId); await writeFile(join(artifacts, `${item.mode}-${item.width}.html`), dom.result.value);
    await command('Target.closeTarget', { targetId });
    console.log(JSON.stringify(result)); assert.ok(result?.pass, JSON.stringify(result)); results.push(result);
  }
  assert.equal(points[0].mapColor, null); assert.equal(points[0].isOurPoint, true);
  assert.equal(points[0].mapWidth, 120); assert.equal(points[0].mapHeight, 140);
  assert.equal(points[1].mapWidth, null); assert.equal(points[1].mapX, 34);
  assert.ok(layouts.get(2).escalator.published);
  await writeFile(join(artifacts, 'map-results.json'), JSON.stringify({ results, mutations, points, layouts: [...layouts] }, null, 2));
  console.log('PASS: mouse geometry, persistence and all map widths. Artifacts: ' + artifacts);
} finally {
  await browser?.close(); await web?.close();
  proxy?.closeAllConnections(); await new Promise(resolve => proxy ? proxy.close(resolve) : resolve());
  api.closeAllConnections(); await new Promise(resolve => api.close(resolve));
}
