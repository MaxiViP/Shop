import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { computed, reactive, ref, watch, nextTick } from 'vue';
import { kopecksToRubles, rublesToKopecks } from '../app/utils/money.ts';
import { hitModes, seasonGroups, seasonGroupLabel } from '../app/utils/badges.ts';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const settings = { periodDays: 14, minOrders: 7, shareBps: 2500, lastCalculatedAt: null };
const template = { id: 7, name: 'Зима', startMonth: 11, endMonth: 2, active: true, _count: { products: 0 } };
const products = [{ id: 1, name: 'Яблоки' }, { id: 3, name: 'Груши' }];
async function fixture(t, page, recovered = false) {
  const models = {
    '/admin/hits': ref(recovered ? null : { settings, items: [], total: 0 }),
    '/admin/categories': ref([{ id: 1, name: 'Фрукты' }]),
    '/admin/seasons': ref([template]),
    '/admin/seasons/presets': ref([]),
    '/admin/products': ref({ items: products, total: 2 }),
  };
  const requests = [], toasts = [], refreshes = [], stops = [], metadata = [];
  let source = (await readFile(new URL('../app/pages/admin/' + page + '.vue', import.meta.url), 'utf8'))
    .split('<script setup lang="ts">')[1].split('</script>')[0];
  const parsed = ts.createSourceFile(page + '.ts', source, ts.ScriptTarget.Latest, true);
  for (const statement of [...parsed.statements].reverse()) if (ts.isImportDeclaration(statement))
    source = source.slice(0, statement.getStart()) + source.slice(statement.end);
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const context = { computed, reactive, ref, kopecksToRubles, rublesToKopecks, hitModes, seasonGroups, seasonGroupLabel,
    watch: (...args) => { const stop = watch(...args); stops.push(stop); return stop; },
    definePageMeta: value => metadata.push(value), useOrderPolling() {},
    useApi: async path => ({ data: models[path], pending: ref(false), error: ref(null), refresh: async () => { refreshes.push(path); } }),
    useApiClient: () => async (path, options) => { requests.push({ path, ...options }); return { count: 2 }; },
    useToast: () => ({ add: value => toasts.push(value) }), apiError: value => String(value),
  };
  const state = page === 'hits'
    ? 'return { query, periodDays, minOrders, share, save, recalculate, busy, showMode, setMode };'
    : 'return { query, name, description, templateGroup, startMonth, endMonth, templateActive, saveTemplate, toggleTemplate, editTemplate, selected, select, mode, templateId, confirmation, assign, busy, addPresets, showProducts };';
  const result = await new AsyncFunction(...Object.keys(context), code + '\n' + state)(...Object.values(context));
  t.after(() => stops.forEach(stop => stop()));
  assert.deepEqual(metadata, [{ middleware: 'admin', layout: 'admin' }]);
  return { ...result, models, requests, toasts, refreshes };
}

test('hit settings recover the real server values after a failed initial load and preserve later user edits during polling', async t => {
  const f = await fixture(t, 'hits', true);
  f.models['/admin/hits'].value = { settings, items: [], total: 0 };
  await nextTick();
  assert.equal(f.periodDays.value, 14);
  assert.equal(f.minOrders.value, 7);
  assert.equal(f.share.value, '25.00');
  f.periodDays.value = 11;
  f.models['/admin/hits'].value = { settings: { ...settings, periodDays: 30 }, items: [], total: 0 };
  await nextTick();
  assert.equal(f.periodDays.value, 11);
});

test('hit settings save to the ADMIN endpoint and manual recalculation refreshes statistics', async t => {
  const f = await fixture(t, 'hits');
  f.periodDays.value = 30; f.minOrders.value = 3; f.share.value = '15';
  await f.save(); await f.recalculate();
  assert.deepEqual(f.requests, [
    { path: '/admin/hits/settings', method: 'PATCH', body: { periodDays: 30, minOrders: 3, shareBps: 1500 } },
    { path: '/admin/hits/recalculate', method: 'POST' },
  ]);
  assert.deepEqual(f.refreshes, ['/admin/hits', '/admin/hits']);
  assert.equal(f.busy.value, false);
  f.share.value = '100.01'; await f.save();
  assert.equal(f.requests.length, 2);
  assert.equal(f.toasts.at(-1).color, 'error');
});

test('calendar management creates a wrapped template and explicitly disables an existing template', async t => {
  const f = await fixture(t, 'seasons');
  f.name.value = '  Зима  '; f.startMonth.value = 11; f.endMonth.value = 2;
  await f.saveTemplate(); await f.toggleTemplate(template);
  assert.deepEqual(f.requests, [
    { path: '/admin/seasons', method: 'POST', body: { name: 'Зима', description: null, group: null, startMonth: 11, endMonth: 2, active: true } },
    { path: '/admin/seasons/7', method: 'PATCH', body: { active: false } },
  ]);
});

test('calendar assignment retains selection across pages, requires confirmation and sends only selected IDs', async t => {
  const f = await fixture(t, 'seasons');
  f.select(products[0], true);
  f.models['/admin/products'].value = { items: [products[1]], total: 2 };
  f.select(products[1], true); f.templateId.value = 7;
  await f.assign();
  assert.equal(f.requests.length, 0);
  assert.deepEqual(f.selected.value.map(item => item.id), [1, 3]);
  f.confirmation.value = true; await f.assign();
  assert.deepEqual(f.requests, [{ path: '/admin/seasons/assign', method: 'POST', body: { ids: [1, 3], seasonalMode: 'AUTO', seasonTemplateId: 7 } }]);
  assert.equal(f.selected.value.length, 0);
  assert.equal(f.confirmation.value, false);
  assert.deepEqual(f.refreshes, ['/admin/products', '/admin/seasons']);
});

test('manual hit groups and changes use ADMIN mutations without submitting statistics', async t => {
  const f = await fixture(t, 'hits');
  f.query.page = 2; f.showMode('MANUAL');
  assert.equal(f.query.page, 1); assert.equal(f.query.hitMode, 'MANUAL');
  for (const hitMode of ['MANUAL', 'OFF', 'AUTO']) await f.setMode(products[0], hitMode);
  assert.deepEqual(f.requests.map(item => item.body), ['MANUAL', 'OFF', 'AUTO'].map(hitMode => ({ ids: [1], hitMode })));
  assert.ok(f.requests.every(item => item.path === '/admin/hits/assign'));
});

test('presets are explicitly requested and linked-product browsing filters by template ID', async t => {
  const f = await fixture(t, 'seasons');
  await f.addPresets(); f.showProducts(7);
  assert.deepEqual(f.requests, [{ path: '/admin/seasons/presets', method: 'POST' }]);
  assert.equal(f.query.seasonTemplateId, 7);
  f.showProducts(); assert.equal(f.query.seasonTemplateId, undefined);
});
