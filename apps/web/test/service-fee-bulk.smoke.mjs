// Real compiled API + dedicated PostgreSQL only. Build api and web before running.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { serviceFeeApi } from './fixtures/service-fee-api.mjs';
import { startWeb } from './browser.mjs';
const artifacts=await mkdtemp(join(tmpdir(),'korzina-fee-bulk-browser-'));
let api,web,browser,page;
const checks=[],errors=[];
try {
  api=await serviceFeeApi();web=await startWeb(api.apiBase);
  const request=(path,body,role='ADMIN',method='POST')=>fetch(api.apiBase+path,{method,headers:{'Content-Type':'application/json',Cookie:api.cookieName+'='+role},body:JSON.stringify(body)});
  const global=async value=>assert.equal((await request('/admin/settings',{globalServiceMarkupPercent:value},'ADMIN','PATCH')).status,200);
  await global(15);
  browser=await chromium.launch({executablePath:process.env.CATALOG_BROWSER_PATH??'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
  const context=await browser.newContext({viewport:{width:320,height:900}});
  await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  await context.addCookies([{name:api.cookieName,value:'ADMIN',url:web.base,httpOnly:true}]);
  page=await context.newPage();page.setDefaultTimeout(15000);
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(/hydration.*mismatch/i.test(message.text()))errors.push(message.text());});
  const noOverflow=async()=>{
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    const dialog=page.getByRole('dialog');
    if(await dialog.count()){
      assert.ok(await dialog.evaluate(node=>node.scrollWidth<=node.clientWidth+1));
      assert.ok(await dialog.evaluate(node=>{
        const header=node.querySelector('[data-slot="header"]'),box=header.getBoundingClientRect();
        return ['title','description'].every(slot=>{
          const text=node.querySelector('[data-slot="'+slot+'"]'),rect=text.getBoundingClientRect();
          return rect.top>=box.top&&rect.bottom<=box.bottom&&rect.right<=box.right;
        });
      }),'Preview heading and description must fit inside their header');
    }
  };
  const target=async name=>{await page.getByRole('combobox',{name:'Товары для перевода',exact:true}).click();await page.getByRole('option',{name,exact:true}).click();};
  const showPreview=async()=>{
    const [r]=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/service-fee/bulk/preview')),page.getByRole('button',{name:'Перевести на общий процент',exact:true}).click()]);
    assert.equal(r.status(),201,await r.text());await expect(page.getByRole('dialog')).toBeVisible();await page.waitForTimeout(300);return r.json();
  };
  const confirm=async()=>{
    await page.getByRole('checkbox',{name:'Подтверждаю изменение цен и очистку индивидуальных процентов у выбранных товаров',exact:true}).check();
    const [r]=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/service-fee/bulk/apply')),page.getByRole('button',{name:'Подтвердить перевод',exact:true}).click()]);
    return r;
  };
  const search=async text=>{
    await page.getByPlaceholder('Название или slug').fill(text);
    const [r]=await Promise.all([page.waitForResponse(r=>new URL(r.url()).pathname==='/api/admin/products'),page.getByRole('button',{name:'Найти',exact:true}).click()]);
    const data=await r.json();if(data.items[0])await expect(page.getByRole('link',{name:data.items[0].name,exact:true})).toBeVisible();return data;
  };
  await page.goto(web.base+'/admin/products',{waitUntil:'networkidle'});
  await expect(page.getByText('Выбрано товаров: 0',{exact:true})).toBeVisible();
  assert.equal((await api.db.product.count({where:{serviceMarkupPercentOverride:10,serviceMarkupNeedsReview:true}})),173);
  assert.equal(await api.db.serviceFeeBulkOperation.count(),0);
  for(const width of [320,768,1280]){await page.setViewportSize({width,height:900});await noOverflow();await page.screenshot({path:join(artifacts,'list-'+width+'.png'),fullPage:true});}
  await page.setViewportSize({width:320,height:900});
  await page.getByRole('checkbox',{name:'Выбрать процент для Перенесённый товар 173',exact:true}).check();
  const single=await showPreview();assert.equal(single.count,1);assert.equal(single.rows[0].before.percent,10);assert.equal(single.rows[0].after.percent,15);
  assert.equal(await api.db.serviceFeeBulkOperation.count(),0);
  assert.equal(await page.getByRole('button',{name:'Подтвердить перевод',exact:true}).isDisabled(),true);
  await noOverflow();await page.screenshot({path:join(artifacts,'single-preview-320.png')});
  await page.getByRole('button',{name:'Отмена',exact:true}).click();
  assert.equal((await api.db.product.findUniqueOrThrow({where:{id:173}})).serviceMarkupPercentOverride,10);
  await showPreview();
  let lost=true,firstRequest;
  await page.route('**/service-fee/bulk/apply',async route=>{
    if(!lost)return route.continue();lost=false;firstRequest=route.request().postDataJSON();
    const response=await route.fetch();assert.equal(response.status(),201);await route.abort('failed');
  });
  await page.getByRole('checkbox',{name:'Подтверждаю изменение цен и очистку индивидуальных процентов у выбранных товаров',exact:true}).check();
  await page.getByRole('button',{name:'Подтвердить перевод',exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('Проверьте подключение');
  await expect.poll(()=>api.db.serviceFeeBulkOperation.count()).toBe(1);
  const committed=await api.db.serviceFeeBulkOperation.findUniqueOrThrow({where:{requestId:firstRequest.requestId}});
  const afterCommit=await api.db.product.findMany({orderBy:{id:'asc'}});
  const auditsAfterCommit=await api.db.adminAudit.findMany({orderBy:{id:'asc'}});
  assert.equal(committed.result.changedCount,1);
  const changedProduct=afterCommit.find(row=>row.id===173);
  assert.equal(changedProduct.price,10000);
  assert.equal(changedProduct.serviceMarkupPercentOverride,null);
  assert.equal(changedProduct.serviceMarkupPercent,15);
  assert.equal(changedProduct.normalizedPrice.toNumber(),11500);
  const [retried]=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/service-fee/bulk/apply')&&r.status()===201),page.getByRole('button',{name:'Подтвердить перевод',exact:true}).click()]);
  assert.deepEqual(retried.request().postDataJSON(),firstRequest);
  assert.deepEqual(await retried.json(),committed.result);
  assert.deepEqual(await api.db.product.findMany({orderBy:{id:'asc'}}),afterCommit);
  assert.deepEqual(await api.db.adminAudit.findMany({orderBy:{id:'asc'}}),auditsAfterCommit);
  assert.equal(await api.db.serviceFeeBulkOperation.count(),1);
  assert.deepEqual(await api.history(),api.historical);
  await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.getByText('Выбрано товаров: 0',{exact:true})).toBeVisible();
  assert.equal(await api.db.adminAudit.count({where:{action:'PRODUCT_MARKUP_CHANGED'}}),1);
  checks.push('single explicit selection; cancel does not write; mandatory confirmation; lost committed response replays the same requestId once');
  await page.unroute('**/service-fee/bulk/apply');
  await page.getByRole('combobox',{name:'Сервисный процент',exact:true}).click();await page.getByRole('option',{name:'Требуют проверки миграции',exact:true}).click();
  const filtered=await search('');assert.equal(filtered.total,172);assert.equal(filtered.pages,9);
  const boxes=page.getByRole('checkbox',{name:/^Выбрать процент для/});for(let i=0;i<10;i++)await boxes.nth(i).check();
  const ten=await showPreview();assert.equal(ten.count,10);assert.equal(ten.changedCount,10);assert.equal((await confirm()).status(),201);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  assert.equal(await api.db.product.count({where:{serviceMarkupPercentOverride:null}}),11);
  checks.push('server review filter, accurate pagination/count and ten selected exceptions');
  // Fresh migrated test data for the full 173-row scenario. Never touches a working database.
  await api.db.product.updateMany({where:{id:{lte:173}},data:{serviceMarkupPercentOverride:10,serviceMarkupPercent:10,serviceMarkupNeedsReview:true}});
  const create=async(name,override)=>{
    const r=await request('/admin/products',{name,slug:'bulk-'+crypto.randomUUID(),description:null,price:10000,unit:'PIECE',priceQty:1,min:1,step:1,portionQty:1,
      categoryId:api.categoryId,active:true,sort:0,serviceMarkupPercentOverride:override});assert.equal(r.status,201,await r.clone().text());return r.json();
  };
  const zero=await create('Подтверждённое исключение 0%',0);
  await page.reload({waitUntil:'networkidle'});await target('Все требующие проверки');
  await expect(page.getByText('Выбрано товаров: 173',{exact:true})).toBeVisible();
  const all=await showPreview();assert.equal(all.count,173);assert.equal(all.changedCount,173);assert.ok(all.rows.every(r=>r.before.percent===10&&r.after.percent===15));
  assert.ok(!all.rows.some(r=>r.id===zero.id));
  for(const width of [320,768,1280]){
    await page.setViewportSize({width,height:900});await noOverflow();await page.waitForTimeout(100);
    await page.screenshot({path:join(artifacts,'all-preview-'+width+'.png')});
  }
  await page.setViewportSize({width:320,height:900});
  await page.getByRole('button',{name:'Следующие',exact:true}).click();await expect(page.getByText('Страница 2 / 9',{exact:true})).toBeVisible();
  await global(20);assert.equal((await confirm()).status(),409);
  await expect(page.getByRole('dialog')).toContainText('Обновите предварительный расчёт');
  assert.equal(await page.getByRole('button',{name:'Подтвердить перевод',exact:true}).isDisabled(),true);
  assert.equal(await api.db.product.count({where:{serviceMarkupNeedsReview:true}}),173);
  await global(15);
  const [fresh]=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/service-fee/bulk/preview')),page.getByRole('button',{name:'Обновить предварительный расчёт',exact:true}).click()]);
  const renewed=await fresh.json();assert.notEqual(renewed.previewToken,all.previewToken);
  assert.equal(await page.getByRole('button',{name:'Подтвердить перевод',exact:true}).isDisabled(),true);
  assert.equal((await confirm()).status(),201);await expect(page.getByRole('dialog')).toHaveCount(0);
  assert.equal(await api.db.product.count({where:{id:{lte:173},serviceMarkupPercentOverride:null,serviceMarkupPercent:15,serviceMarkupNeedsReview:false}}),173);
  assert.equal((await api.db.product.findUniqueOrThrow({where:{id:zero.id}})).serviceMarkupPercentOverride,0);
  checks.push('173-row server selection excludes confirmed zero; 10 to 15 preview, mobile pagination, stale 409 and reconfirmed fresh apply');
  for(let i=0;i<3;i++)await create('Результат поиска bulk '+i,20);
  await page.reload({waitUntil:'networkidle'});assert.equal((await search('Результат поиска bulk')).total,3);
  await target('Все по применённому фильтру списка');await expect(page.getByText('Выбрано товаров: 3',{exact:true})).toBeVisible();
  const found=await showPreview();assert.equal(found.count,3);assert.ok(found.rows.every(r=>r.difference===-500));
  assert.equal((await confirm()).status(),201);await expect(page.getByRole('dialog')).toHaveCount(0);
  checks.push('complete applied search filter and server-calculated price decreases');
  for(const role of ['SELLER','OWNER','OTHER_ADMIN']){
    assert.equal((await request('/admin/products/service-fee/bulk/preview',{selection:{kind:'ids',ids:[1]},mode:'global'},role)).status,403);
    assert.equal((await request('/admin/products/service-fee/bulk/apply',{previewToken:found.previewToken,requestId:crypto.randomUUID(),confirmed:true},role)).status,403);
  }
  assert.deepEqual(await api.history(),api.historical);
  for(const r of api.requests.filter(r=>r.path.includes('/service-fee/bulk/'))){assert.ok(!Object.hasOwn(r.body,'prices'));assert.ok(!Object.hasOwn(r.body,'serviceMarkupPercent'));}
  assert.deepEqual(errors,[]);checks.push('real seller/owner/non-primary admin guards, durable audit/idempotency and unchanged historical order/payment');
  console.log(JSON.stringify({artifacts,checks,errors},null,2));
} finally {
  if(page&&!page.isClosed()){await page.screenshot({path:join(artifacts,'last-page.png'),fullPage:true}).catch(()=>{});await writeFile(join(artifacts,'last-page.html'),await page.content());}
  await browser?.close();await web?.close();await api?.close();await writeFile(join(artifacts,'report.json'),JSON.stringify({checks,errors},null,2));console.log('Artifacts: '+artifacts);
}
