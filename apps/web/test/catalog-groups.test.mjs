import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { computed, reactive, ref, watch, nextTick } from 'vue';

const source = await readFile(new URL('../app/composables/useCatalog.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('catalog.ts', source, ts.ScriptTarget.Latest, true);
let code = source;
for (const statement of [...parsed.statements].reverse()) {
  if (ts.isImportDeclaration(statement)) code = code.slice(0, statement.getStart()) + code.slice(statement.end);
}
code = ts.transpileModule(code.replace(/^export /gm, ''), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const product = (id, slug = 'fruits') => ({ id, name: 'Яблоки', category: { slug, name: slug }, price: 10000 });
const response = items => ({ items, total: items.length, page: 1, limit: 24, pages: 1,
  currentCategory: { slug: 'fruits', name: 'Фрукты' } });
async function fixture(t, initial = response([product(1), product(2, 'market')]), category = 'fruits') {
  const route = reactive({ query: { q: 'яблоко', sort: 'price_asc' } });
  const q = computed(() => route.query.q ?? '');
  const data = ref(initial), error = ref(null), requests = [], stops = [];
  const state = { next: response([]), refresh: async () => {} };
  const context = {
    ref, computed,
    watch: (...args) => { const stop = watch(...args); stops.push(stop); return stop; },
    useRoute: () => route,
    useRouter: () => ({ replace: async value => { route.query = value.query; } }),
    useProductSearch: () => ({ search: ref(q.value), q, submitSearch() {}, clearSearch() { route.query.q = ''; } }),
    useApi: async () => ({ data, error, status: ref('success'), refresh: () => state.refresh() }),
    useApiClient: () => async (path, options) => { requests.push({ path, ...options }); return state.next; },
  };
  const setup = new AsyncFunction(...Object.keys(context), 'category', code + '\nreturn useCatalog(category ?? undefined);');
  const catalog = await setup(...Object.values(context), category);
  t.after(() => stops.forEach(stop => stop()));
  return { catalog, route, state, data, error, requests };
}

test('category search renders disjoint current-first groups with backend category names', async t => {
  const { catalog } = await fixture(t);
  assert.deepEqual(catalog.groups.value.map(group => [group.label, group.items.map(item => item.id)]),
    [['Фрукты', [1]], ['Везде', [2]]]);
  assert.equal(new Set(catalog.groups.value.flatMap(group => group.items.map(item => item.id))).size, 2);
  assert.deepEqual(catalog.categoryQuery.value, { q: 'яблоко', sort: 'price_asc' });
});

test('missing current matches starts with everywhere; missing external matches omits that block', async t => {
  for (const [items, labels] of [[[product(2, 'market')], ['Везде']], [[product(1)], ['Фрукты']], [[], []]]) {
    const { catalog } = await fixture(t, response(items));
    assert.deepEqual(catalog.groups.value.map(group => group.label), labels);
  }
});

test('general catalog search uses one grid and grouping keys stay unique even for a category named Везде', async t => {
  const global = await fixture(t, response([product(1), product(2, 'market')]), null);
  assert.deepEqual(global.catalog.groups.value, []);
  assert.equal(global.catalog.items.value.length, 2);
  const initial = { ...response([product(1), product(2, 'market')]), currentCategory: { slug: 'fruits', name: 'Везде' } };
  const { catalog } = await fixture(t, initial);
  assert.equal(new Set(catalog.groups.value.map(group => group.key)).size, 2);
});

test('show more preserves both group priorities and removes repeated product cards across pages', async t => {
  const { catalog, state, requests } = await fixture(t, { ...response([product(1), product(2, 'market')]), total: 4, pages: 2 });
  state.next = { ...response([product(1), product(3), product(4, 'market')]), total: 4, page: 2, pages: 2 };
  await catalog.loadMore();
  assert.deepEqual(catalog.groups.value.map(group => group.items.map(item => item.id)), [[1, 3], [2, 4]]);
  assert.equal(catalog.hasMore.value, false);
  assert.deepEqual(requests[0].query, { q: 'яблоко', category: 'fruits', sort: 'price_asc', page: 2, limit: 24 });
});

test('an old page request cannot append stale cards after changing the search', async t => {
  const { catalog, route, state } = await fixture(t, { ...response([product(1)]), total: 30, pages: 2 });
  let release;
  state.next = new Promise(resolve => { release = resolve; });
  const old = catalog.loadMore();
  route.query.q = 'груша'; await nextTick();
  release({ ...response([product(10)]), page: 2 }); await old;
  assert.equal(catalog.items.value.some(item => item.id === 10), false);
});

test('breadcrumbs and category links preserve search, with one existing product card grid per visible group', async () => {
  const [view, categories] = await Promise.all([
    readFile(new URL('../app/components/catalog/View.vue', import.meta.url), 'utf8'),
    readFile(new URL('../app/components/category/List.vue', import.meta.url), 'utf8'),
  ]);
  assert.match(view, /query: categoryQuery\.value/);
  assert.match(view, /:query="categoryQuery"/);
  assert.match(view, /<h2 class="catalog__group-title">/);
  assert.match(view, /:key="group\.key"/);
  assert.match(view, /<ProductGrid :items="group\.items"\s*\/>/);
  assert.match(view, /Ничего не найдено/);
  assert.match(categories, /query/);
});
