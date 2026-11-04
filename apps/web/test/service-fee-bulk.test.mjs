import assert from 'node:assert/strict';
import test from 'node:test';
import { ref, reactive, computed, watch, nextTick } from 'vue';
import { serviceHelpers, serviceComponent } from './fixtures/service-fee.mjs';
const helpers=await serviceHelpers();
const rows=Array.from({length:173},(_,i)=>({id:i+1,name:'Товар '+(i+1),sellerPrice:10000,priceQty:1,unit:'PIECE',
  before:{mode:'individual',override:10,percent:10,customerPrice:11000,needsReview:true},
  after:{mode:'global',override:null,percent:15,customerPrice:11500,needsReview:false},difference:500,differenceBps:455,changed:true}));
const preview={previewToken:'signed-1',expiresAt:'2030-01-01T12:00:00.000Z',globalPercent:15,count:173,changedCount:173,rows,
  totals:{beforePrice:1903000,afterPrice:1989500,difference:86500,differenceBps:455}};
const result={requestId:'result',count:173,changedCount:173,skippedCount:0,globalPercent:15,productIds:rows.map(r=>r.id),appliedAt:'2030-01-01T12:00:00.000Z'};
async function editor(t,handler) {
  const ids=ref([]),requests=[],events=[],stops=[],props=reactive({filter:{search:'Яблоки',serviceFeeMode:'review'},total:42,pending:false});
  t.after(()=>stops.forEach(stop=>stop()));
  const context={ref,reactive,computed,...helpers,apiError:helpers.apiError,defineProps:()=>props,defineModel:()=>ids,
    defineEmits:()=> (...args)=>events.push(args),watch:(...args)=>{const stop=watch(...args);stops.push(stop);return stop;},
    useApiClient:()=>async(path,options)=>{requests.push({path,...options});if(handler)return handler(path,options,requests);return path==='/admin/products'?{total:173}:path.endsWith('/preview')?structuredClone(preview):result;},
  };
  return {...await serviceComponent('ServiceFeeBulk.vue',context,'scope, selection, selectedCount, preview, visibleRows, previewPages, loadPreview, applyPreview, confirmed, open, error, outdated, requestId'),ids,props,requests,events};
}
const settle=async()=>{await nextTick();await new Promise(resolve=>setTimeout(resolve,0));};

test('bulk is opt-in and review count/filter comes from server before pagination',async t=>{
  const e=await editor(t);assert.equal(e.scope.value,'ids');assert.equal(e.selectedCount.value,0);assert.equal(e.requests.length,0);
  e.scope.value='review';await settle();assert.equal(e.selectedCount.value,173);
  assert.deepEqual(e.requests[0],{path:'/admin/products',query:{serviceFeeMode:'review',page:1,limit:1}});
  await e.loadPreview();assert.deepEqual(e.requests.at(-1).body,{selection:{kind:'filter',filter:{serviceFeeMode:'review'}},mode:'global'});
  assert.equal(e.preview.value.count,173);assert.equal(e.visibleRows.value.length,20);assert.equal(e.previewPages.value,9);
  assert.equal(e.confirmed.value,false);const before=e.requests.length;await e.applyPreview();assert.equal(e.requests.length,before);
});
test('applied search filter selects all results and never sends page or trusted prices',async t=>{
  const e=await editor(t);e.scope.value='filter';await settle();assert.equal(e.selectedCount.value,42);
  await e.loadPreview();assert.deepEqual(e.requests.at(-1).body.selection,{kind:'filter',filter:{search:'Яблоки',serviceFeeMode:'review'}});
  assert.deepEqual(Object.keys(e.requests.at(-1).body).sort(),['mode','selection']);
});
test('explicit selection requires confirmation and retry keeps requestId after network failure',async t=>{
  let attempts=0;
  const e=await editor(t,(path)=>{if(path.endsWith('/apply')){if(!attempts++)throw {message:'Failed to fetch'};return result;}return structuredClone(preview);});
  e.ids.value=[1,2];await settle();await e.loadPreview();assert.deepEqual(e.requests.at(-1).body.selection,{kind:'ids',ids:[1,2]});
  e.confirmed.value=true;await e.applyPreview();const first=e.requests.at(-1);assert.match(e.error.value,/подключение/);assert.equal(e.outdated.value,false);
  await e.applyPreview();assert.deepEqual(e.requests.at(-1).body,first.body);assert.deepEqual(Object.keys(first.body).sort(),['confirmed','previewToken','requestId']);
  assert.equal(e.open.value,false);assert.deepEqual(e.ids.value,[]);assert.equal(e.events[0][0],'applied');
});
test('stale 409 disables apply until a new preview is requested and confirmed',async t=>{
  let count=0;
  const e=await editor(t,path=>{if(path.endsWith('/apply'))throw {statusCode:409,data:{code:'SERVICE_FEE_STALE',message:'Обновите предварительный расчёт'}};return {...structuredClone(preview),previewToken:'signed-'+ ++count};});
  e.ids.value=[1];await settle();await e.loadPreview();const key=e.requestId.value;
  e.confirmed.value=true;await e.applyPreview();assert.equal(e.outdated.value,true);const n=e.requests.length;await e.applyPreview();assert.equal(e.requests.length,n);
  await e.loadPreview();assert.equal(e.outdated.value,false);assert.equal(e.confirmed.value,false);assert.notEqual(e.requestId.value,key);
});
test('in-progress 409 allows explicit retry with the same idempotency key',async t=>{
  const e=await editor(t,path=>{if(path.endsWith('/apply'))throw {statusCode:409,data:{code:'SERVICE_FEE_IN_PROGRESS',message:'Повторите запрос'}};return structuredClone(preview);});
  e.ids.value=[1];await settle();await e.loadPreview();e.confirmed.value=true;await e.applyPreview();const body=e.requests.at(-1).body;
  assert.equal(e.outdated.value,false);await e.applyPreview();assert.deepEqual(e.requests.at(-1).body,body);
});
test('selection changes while preview is in flight cannot open an obsolete preview',async t=>{
  let release;const e=await editor(t,()=>new Promise(resolve=>{release=resolve;}));
  e.ids.value=[1];await settle();const pending=e.loadPreview();e.ids.value=[2];await settle();release(structuredClone(preview));await pending;
  assert.equal(e.open.value,false);assert.equal(e.preview.value,null);assert.match(e.error.value,/Выбор изменился/);
});
