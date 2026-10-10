import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { computed, reactive, ref, shallowRef, watch, nextTick, toValue } from 'vue';
import { catalogGroups, visibleCategory } from '../app/utils/catalog.ts';
import { queryText } from '../app/utils/search.ts';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
function executable(source) {
  const parsed = ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true);
  for (const statement of [...parsed.statements].reverse())
    if (ts.isImportDeclaration(statement)) source = source.slice(0, statement.getStart()) + source.slice(statement.end);
  return ts.transpileModule(source.replace(/^export /gm, '').replaceAll('import.meta.client', 'true'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
}
const feedCode = executable(await readFile(new URL('../app/composables/useProductFeed.ts', import.meta.url), 'utf8'));
const catalogCode = executable(await readFile(new URL('../app/composables/useCatalog.ts', import.meta.url), 'utf8'));
const sortCode = executable(await readFile(new URL('../app/composables/useProductSort.ts', import.meta.url), 'utf8'));
const homeCode = executable((await readFile(new URL('../app/pages/index.vue', import.meta.url), 'utf8')).split('<script setup lang="ts">')[1].split('</script>')[0]);
test('sorting preserves the existing Russian labels, values and Lucide icons', () => {
  const options = new Function(sortCode + '\nreturn productSortOptions;')();
  assert.deepEqual(options.map(option => [option.value, option.label]), [
    ['recommended', 'Рекомендуемые'], ['price_asc', 'Сначала дешевле'], ['price_desc', 'Сначала дороже'],
    ['newest', 'Новинки'], ['name', 'По названию'],
  ]);
  assert.ok(options.every(option => option.icon.startsWith('i-lucide-')));
});
const product = (id, slug = 'fruits') => ({ id, name: 'Яблоки', price: 11000,
  category: { slug, name: { fruits: 'Фрукты', vegetables: 'Овощи', greens: 'Зелень' }[slug] ?? slug } });
const response = (items, nextCursor = null) => ({ items, total: items.length, nextCursor, page: 1, limit: 24, pages: 1 });

async function fixture(t, initial = response([product(1)], 'cursor-1'), category, query = {}, home = false) {
  const route = reactive({ query });
  const requests = [], initialRequests = [], history = [], stops = [];
  const state = { next: response([]) };
  const context = {
    ref, shallowRef, computed, toValue, queryText, catalogGroups,
    watch: (...args) => { const stop = watch(...args); stops.push(stop); return stop; },
    onScopeDispose: fn => stops.push(fn),
    useRoute: () => route,
    useRouter: () => ({ replace: async target => { history.push(target); route.query = target.query; } }),
    site: { title: 'Local test', description: 'Local test' }, storeSchema: () => ({}), usePageSeo() {}, useJsonLd() {},
    useProductSearch: () => ({ search: ref(queryText(route.query.q)), q: computed(() => queryText(route.query.q)),
      submitSearch() {}, clearSearch() { route.query.q = ''; } }),
    useApi: async (path, options) => {
      if (path === '/categories') return { data: ref([]) };
      initialRequests.push({ path, options, query: { ...options.query.value } });
      return { data: ref(initial), error: ref(null), status: ref('success') };
    },
    useApiClient: () => async (path, options) => { requests.push({ path, ...options }); return state.next; },
  };
  const sortKeys = Object.keys(context), sortSetup = new Function(...sortKeys, sortCode + '\nreturn useProductSort();');
  context.useProductSort = () => sortSetup(...sortKeys.map(key => context[key]));
  const feedKeys = Object.keys(context), feedSetup = new AsyncFunction(...feedKeys, 'query', 'key', feedCode + '\nreturn useProductFeed(query, key);');
  context.useProductFeed = (q, key) => feedSetup(...feedKeys.map(name => context[name]), q, key);
  const catalogSetup = new AsyncFunction(...Object.keys(context), 'category', catalogCode + '\nreturn useCatalog(category);');
  const homeSetup = new AsyncFunction(...Object.keys(context), homeCode + '\nreturn { sort, sortQuery, items, loadMore, retry };');
  const catalog = home ? await homeSetup(...Object.values(context)) : await catalogSetup(...Object.values(context), category);
  t.after(() => stops.reverse().forEach(stop => stop()));
  return { catalog, route, requests, initialRequests, history, state, context };
}

test('SSR/hydration reuses the first page and cursor without issuing a second request or rearranging items', async t => {
  const initial = { ...response([product(7), product(3), product(5)], 'server-cursor'), seed: 'server-seed' };
  const { catalog, requests, initialRequests } = await fixture(t, initial);
  assert.deepEqual(catalog.items.value.map(item => item.id), [7, 3, 5]);
  assert.equal(requests.length, 0);
  assert.equal(initialRequests.length, 1);
  assert.equal(initialRequests[0].query.feed, 'catalog');
  assert.equal(initialRequests[0].options.watch, false);
  assert.equal(catalog.hasMore.value, true);
});

for (const tag of ['hit', 'seasonal']) test(tag + ' selection keeps its badges, category and search on every cursor page', async t => {
  const item = { ...product(1), isHit: true, isSeasonal: true };
  const { catalog, state, requests, initialRequests, route } = await fixture(t, response([item], 'tag-cursor'), 'fruits', { tag, q: 'яблоко' });
  assert.equal(initialRequests[0].query.tag, tag);
  assert.equal(catalog.categoryQuery.value.tag, tag);
  state.next = response([{ ...item, id: 2 }], 'tag-cursor-2');
  await catalog.loadMore();
  assert.deepEqual(requests[0].query, { feed: 'catalog', category: 'fruits', q: 'яблоко', tag, sort: 'recommended', limit: 24, cursor: 'tag-cursor' });
  assert.ok(catalog.items.value.every(item => item.isHit && item.isSeasonal));
  state.next = response([item]);
  route.query.tag = tag === 'hit' ? 'seasonal' : 'hit';
  await nextTick();
  assert.equal(requests.at(-1).query.cursor, undefined);
  assert.equal(requests.at(-1).query.tag, route.query.tag);
});

test('All appends bounded cursor pages without duplicate cards, keeps sorting/filters and stops at the end', async t => {
  const { catalog, requests, state } = await fixture(t, response([product(1), product(2)], 'cursor-1'), undefined,
    { sort: 'price_asc', q: 'яблоко', marketPoint: 'stall' });
  state.next = response([product(2), product(3), product(3)], 'cursor-2');
  await catalog.loadMore();
  assert.deepEqual(catalog.items.value.map(item => item.id), [1, 2, 3]);
  assert.deepEqual(requests[0].query, { feed: 'catalog', category: undefined, q: 'яблоко', marketPoint: 'stall', sort: 'price_asc', limit: 24, cursor: 'cursor-1' });
  state.next = response([product(4)]);
  await catalog.loadMore(); await catalog.loadMore();
  assert.equal(requests.length, 2);
  assert.equal(catalog.hasMore.value, false);
  assert.deepEqual(catalog.groups.value, []);
});

test('category pages preserve Фрукты → Овощи → Зелень as independent groups without empty headings', async t => {
  const { catalog, state } = await fixture(t, response([product(1)], 'c1'), 'fruits');
  state.next = response([product(2), product(3, 'vegetables')], 'c2');
  await catalog.loadMore();
  state.next = response([product(4, 'greens')]);
  await catalog.loadMore();
  assert.deepEqual(catalog.groups.value.map(group => [group.key, group.label, group.items.map(item => item.id)]), [
    ['fruits', 'Фрукты', [1, 2]], ['vegetables', 'Овощи', [3]], ['greens', 'Зелень', [4]],
  ]);
});

test('parallel intersection callbacks issue one request; failed pages retain cards and can retry the same cursor', async t => {
  const { catalog, state, requests } = await fixture(t);
  let release;
  state.next = new Promise(resolve => { release = resolve; });
  const pending = catalog.loadMore(); await catalog.loadMore();
  assert.equal(requests.length, 1);
  release(response([product(2)], 'c2')); await pending;
  state.next = Promise.reject(new Error('network outage'));
  await catalog.loadMore();
  assert.deepEqual(catalog.items.value.map(item => item.id), [1, 2]);
  assert.ok(catalog.error.value);
  assert.equal(catalog.loadingMore.value, false);
  state.next = response([product(3)]);
  await catalog.retry();
  assert.equal(requests.at(-1).query.cursor, 'c2');
  assert.equal(catalog.error.value, null);
  assert.deepEqual(catalog.items.value.map(item => item.id), [1, 2, 3]);
});

test('a repeated cursor becomes a recoverable error instead of an automatic request loop', async t => {
  const { catalog, state, requests } = await fixture(t);
  state.next = response([product(2)], 'cursor-1');
  await catalog.loadMore();
  assert.ok(catalog.error.value);
  assert.deepEqual(catalog.items.value.map(item => item.id), [1]);
  assert.equal(requests.length, 1);
});

test('a changed home catalogue keeps displayed cards and explicitly restarts on refresh instead of reusing stale ranks', async t => {
  const { catalog, state, requests } = await fixture(t);
  state.next = Promise.reject({ statusCode: 409 });
  await catalog.loadMore();
  assert.equal(catalog.stale.value, true);
  assert.deepEqual(catalog.items.value.map(item => item.id), [1]);
  state.next = response([product(3)], 'fresh');
  await catalog.retry();
  assert.equal(requests.at(-1).query.cursor, undefined);
  assert.equal(catalog.stale.value, false);
  assert.deepEqual(catalog.items.value.map(item => item.id), [3]);
});

test('filter/sort changes cancel pending requests and generation guards reject A → B → A stale responses', async t => {
  const { catalog, state, route, requests } = await fixture(t, response([product(1)], 'old'), 'fruits', { q: 'A' });
  let release;
  state.next = new Promise(resolve => { release = resolve; });
  const old = catalog.loadMore();
  state.next = response([product(2)], 'new');
  route.query.q = 'B'; await nextTick();
  state.next = response([product(3)], 'latest');
  route.query.q = 'A'; await nextTick();
  assert.equal(requests[0].signal.aborted, true);
  release(response([product(99)], 'old-2')); await old;
  assert.deepEqual(catalog.items.value.map(item => item.id), [3]);
  state.next = response([product(4)]);
  catalog.sort.value = 'name'; await nextTick(); await nextTick();
  assert.equal(requests.at(-1).query.cursor, undefined);
  assert.equal(requests.at(-1).query.sort, 'name');
  assert.deepEqual(catalog.items.value.map(item => item.id), [4]);
});

test('manual category navigation starts at the selected slug; sort history keeps filters and removes pagination', async t => {
  const fruits = await fixture(t, response([product(1)]), 'fruits', { q: 'яблоко', sort: 'price_asc', marketPoint: 'stall', page: '3' });
  const vegetables = await fixture(t, response([product(2, 'vegetables')]), 'vegetables', fruits.catalog.categoryQuery.value);
  assert.equal(vegetables.initialRequests[0].query.category, 'vegetables');
  assert.equal(vegetables.initialRequests[0].query.cursor, undefined);
  assert.deepEqual(vegetables.catalog.items.value.map(item => item.id), [2]);
  fruits.catalog.sort.value = 'newest'; await nextTick();
  assert.deepEqual(fruits.history[0].query, { q: 'яблоко', sort: 'newest', marketPoint: 'stall' });
});

test('active category follows actual visible cards, including reverse scroll; merely loading a later group does not activate it', () => {
  const first = [{ slug: 'fruits', top: -300, bottom: 500 }, { slug: 'vegetables', top: 540, bottom: 1200 }, { slug: 'greens', top: 1240, bottom: 1800 }];
  assert.equal(visibleCategory(first, 160, 768), 'fruits');
  assert.equal(visibleCategory(first.map(group => ({ ...group, top: group.top - 450, bottom: group.bottom - 450 })), 160, 768), 'vegetables');
  assert.equal(visibleCategory(first.map(group => ({ ...group, top: group.top - 1150, bottom: group.bottom - 1150 })), 160, 768), 'greens');
  assert.equal(visibleCategory(first, 160, 768), 'fruits');
  assert.equal(visibleCategory([{ slug: 'greens', top: 900, bottom: 1800 }], 160, 768), undefined);
  assert.equal(visibleCategory([{ slug: 'vegetables', top: -300, bottom: 166 }, { slug: 'greens', top: 242, bottom: 900 }], 160, 768), 'greens');
  assert.equal(visibleCategory([{ slug: 'vegetables', top: -200, bottom: 260 }, { slug: 'greens', top: 336, bottom: 900 }], 160, 768), 'vegetables');
});

test('home feed preserves the SSR seed/cursor and explicitly requests one bounded mixed page', async t => {
  const { catalog: home, state, requests, initialRequests } = await fixture(t, { ...response([product(1)], 'cursor-1'), seed: 'server-seed' }, undefined, {}, true);
  assert.deepEqual(initialRequests[0].query, { feed: 'home', sort: 'recommended', limit: 24 });
  state.next = response([product(2)], null);
  await home.loadMore();
  assert.equal(requests.at(-1).query.feed, 'home');
  assert.equal(requests.at(-1).query.limit, 24);
  assert.equal(requests.at(-1).query.cursor, 'cursor-1');
});

for (const sort of ['price_asc', 'price_desc', 'name', 'newest']) test('home SSR and subsequent cursor pages use server sorting: ' + sort, async t => {
  const { catalog: home, state, requests, initialRequests } = await fixture(t, response([product(10)], 'sorted-1'), undefined, { sort }, true);
  assert.deepEqual(initialRequests[0].query, { feed: 'catalog', sort, limit: 24 });
  assert.deepEqual(home.sortQuery.value, { sort });
  state.next = response([product(11)], 'sorted-2'); await home.loadMore();
  assert.deepEqual(requests[0].query, { feed: 'catalog', sort, limit: 24, cursor: 'sorted-1' });
  assert.deepEqual(home.items.value.map(item => item.id), [10, 11]);
});

test('changing home sorting aborts the mixed page, resets its cursor and rejects stale responses; recommended restores a fresh mixed feed', async t => {
  const { catalog: home, state, requests } = await fixture(t, response([product(1)], 'mixed-1'), undefined, {}, true);
  let release;state.next = new Promise(resolve => { release = resolve; });
  const pending = home.loadMore();
  state.next = response([product(9)], 'sorted-1');home.sort.value = 'price_desc';await nextTick();
  assert.equal(requests[0].signal.aborted, true);
  assert.deepEqual(requests.at(-1).query, { feed: 'catalog', sort: 'price_desc', limit: 24 });
  release(response([product(99)], 'mixed-2'));await pending;
  assert.deepEqual(home.items.value.map(item => item.id), [9]);
  state.next = response([product(4)], 'fresh-mixed');home.sort.value = 'recommended';await nextTick();
  assert.deepEqual(requests.at(-1).query, { feed: 'home', sort: 'recommended', limit: 24 });
  assert.deepEqual(home.sortQuery.value, {});
  assert.deepEqual(home.items.value.map(item => item.id), [4]);
});

test('sorting uses a floating horizontal radio menu with labelled trigger, keyboard navigation and active state', async () => {
  const view = await readFile(new URL('../app/components/product/Sort.vue', import.meta.url), 'utf8');
  assert.match(view, /<UPopover v-model:open="open"/);
  assert.match(view, /i-lucide-arrow-down-up/);
  assert.match(view, /:aria-expanded="open"/);
  assert.match(view, /role="menuitemradio" :aria-checked="sort === option.value"/);
  assert.match(view, /aria-orientation="horizontal"/);
  assert.match(view, /ArrowRight/); assert.match(view, /ArrowLeft/); assert.match(view, /event.key === 'Home'/); assert.match(view, /event.key === 'End'/);
  assert.match(view, /open.value = false/);
  assert.match(view, /overflow-x: auto/);
});

test('scroll navigation only reveals the active tab horizontally, preserving routes and loaded cards', async () => {
  const [view, categories, home, more] = await Promise.all([
    'components/catalog/View.vue', 'components/category/List.vue', 'pages/index.vue', 'components/product/More.vue',
  ].map(file => readFile(new URL('../app/' + file, import.meta.url), 'utf8')));
  const track = view.slice(view.indexOf('function trackCategory'), view.indexOf('function scheduleTrack'));
  assert.match(track, /grid.getBoundingClientRect/);
  assert.ok(!track.includes('router.') && !track.includes('loadMore') && !track.includes('items.value ='));
  assert.match(categories, /strip.scrollTo\(\{ left:/);
  assert.ok(!categories.includes('scrollIntoView'));
  assert.match(categories, /:to="link\(`/);
  assert.ok(!home.includes('market-about'));
  assert.match(home, /<HomeHeroCarousel/);
  assert.match(home, /sort.value === 'recommended' \? 'home' : 'catalog'/);
  assert.match(more, /new IntersectionObserver/);
  assert.match(more, /!props.loading && !props.error/);
  assert.match(more, /observer\?\.disconnect/);
});
