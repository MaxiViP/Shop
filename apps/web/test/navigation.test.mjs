import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { parse } from 'vue/compiler-sfc';
import { ref, computed, watch, nextTick } from 'vue';
import ts from 'typescript';

function executable(source) {
  const parsed = ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true);
  for (const statement of [...parsed.statements].reverse()) if (ts.isImportDeclaration(statement)) source = source.slice(0, statement.getStart()) + source.slice(statement.end);
  return ts.transpileModule(source.replace(/^export /gm, '').replaceAll('import.meta.client', 'true'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
}
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const list = await readFile(new URL('../app/components/category/List.vue', import.meta.url), 'utf8');
test('category search filters the loaded 100+ categories locally, keeps visible-category state and closes on a manual choice', async t => {
  const events = [], stops = [];
  const items = Array.from({ length: 110 }, (_, id) => ({ id, slug: 'category-' + id, name: 'Категория ' + id }));
  items[42].name = 'Сыры';
  const props = { items, query: { q: 'яблоко', sort: 'price_asc' }, active: 'category-42' };
  const context = { ref, computed, nextTick, useRoute: () => ({ query: {} }), useApi: async () => ({ data: ref([]) }), defineProps: () => props, defineEmits: () => (...args) => events.push(args),
    watch: (...args) => { stops.push(watch(...args)); }, onMounted() {}, onBeforeUnmount() {} };
  const script = executable(parse(list).descriptor.scriptSetup.content);
  const state = await new AsyncFunction(...Object.keys(context), script + '\nreturn { search, filtered, open, chooseCategory, link, current };')(...Object.values(context));
  t.after(() => stops.forEach(stop => stop()));
  assert.equal(state.filtered.value.length, 110);
  state.search.value = '  сЫР  '; assert.deepEqual(state.filtered.value.map(item => item.id), [42]);
  assert.equal(state.current('category-42'), 'page'); assert.equal(state.current('category-2'), 'false');
  state.search.value = 'несуществующая'; assert.equal(state.filtered.value.length, 0);
  state.search.value = ''; state.open.value = true;
  state.chooseCategory({ button: 0, ctrlKey: true }, 'category-1'); assert.equal(state.open.value, true); assert.equal(events.length, 0);
  state.chooseCategory({ button: 0 }, 'category-1'); assert.equal(state.open.value, false); assert.deepEqual(events, [['choose', 'category-1']]);
  assert.deepEqual(state.link('/catalog/category-1'), { path: '/catalog/category-1', query: props.query });
  assert.ok(script.includes('/categories/points')); // Product categories still filter locally.
});

test('hybrid navigation keeps its leading menu and trailing controls outside the scrolling strip and provides an accessible mobile sheet', () => {
  assert.ok(list.indexOf('<UModal') < list.indexOf('<nav ref="nav"'));
  assert.ok(list.indexOf('<nav ref="nav"') < list.indexOf('<slot name="trailing"'));
  assert.match(list, /i-lucide-layout-grid/); assert.match(list, /aria-haspopup="dialog"/);
  assert.match(list, /:aria-expanded="open"/); assert.match(list, /title="Все категории"/);
  assert.match(list, /Категории не найдены/); assert.match(list, /overflow-y: auto/);
  assert.match(list, /grid-template-columns: repeat\(2/); assert.match(list, /88dvh/);
  assert.match(list, /visualViewport/); assert.match(list, /removeEventListener/);
});

test('category modal focuses the dialog first, focuses search only on demand and resets it on collapse or close', async t => {
  const stops = [], properties = new Map();
  let inputFocus = 0, inputBlur = 0, dialogFocus = 0, toggleFocus = 0, prevented = 0;
  const field = { inert: true };
  const input = { focus() { assert.equal(field.inert, false); inputFocus++; }, blur() { inputBlur++; } };
  const toggle = { focus() { toggleFocus++; } };
  const dialog = { offsetHeight: 420, style: { setProperty: (key, value) => properties.set(key, value), removeProperty: key => properties.delete(key) }, focus() { dialogFocus++; } };
  const props = { items: [{ id: 1, slug: 'cheese', name: 'Сыры' }, { id: 2, slug: 'fruit', name: 'Фрукты' }] };
  const context = { ref, computed, nextTick, useRoute: () => ({ query: {} }), useApi: async () => ({ data: ref([]) }), defineProps: () => props, defineEmits: () => () => {},
    watch: (...args) => { stops.push(watch(...args)); }, onMounted() {}, onBeforeUnmount() {},
    window: { innerHeight: 800, visualViewport: { height: 800, offsetTop: 0 } } };
  const script = executable(parse(list).descriptor.scriptSetup.content);
  const state = await new AsyncFunction(...Object.keys(context), script + '\nreturn { open, search, searchOpen, filtered, panel, searchBar, focusPanel, toggleSearch, closeSearch };')(...Object.values(context));
  t.after(() => stops.forEach(stop => stop()));
  state.panel.value = { closest: () => dialog };
  state.searchBar.value = { querySelector: selector => selector === 'input' ? input : selector === '.categories__search-field' ? field : toggle };
  state.open.value = true;
  state.focusPanel({ preventDefault() { prevented++; } });
  await nextTick();
  assert.equal(prevented, 1); assert.equal(dialogFocus, 1); assert.equal(inputFocus, 0);
  assert.equal(state.searchOpen.value, false); assert.equal(state.filtered.value.length, 2);
  assert.equal(properties.get('--categories-open-height'), '420px');
  state.toggleSearch();
  assert.equal(inputFocus, 1, 'Input focus stays in the synchronous tap handler');
  assert.equal(state.searchOpen.value, true);
  state.search.value = ' сЫР '; assert.deepEqual(state.filtered.value.map(item => item.id), [1]);
  state.toggleSearch();
  assert.equal(state.searchOpen.value, false); assert.equal(state.search.value, '');
  assert.equal(state.filtered.value.length, 2); assert.equal(toggleFocus, 1);
  state.toggleSearch(); state.search.value = 'несуществующая';
  state.closeSearch(); assert.equal(state.searchOpen.value, false); assert.equal(state.search.value, '');
  state.toggleSearch(); state.search.value = 'сыр'; state.open.value = false;
  await nextTick();
  assert.equal(state.searchOpen.value, false); assert.equal(state.search.value, ''); assert.equal(state.filtered.value.length, 2);
  assert.ok(inputBlur >= 3);
  state.open.value = true; await nextTick();
  assert.equal(state.searchOpen.value, false); assert.equal(state.filtered.value.length, 2);
});

const windowCode = executable(await readFile(new URL('../app/composables/useGridWindow.ts', import.meta.url), 'utf8'));
test('disabled grids do no DOM work, install no listeners and cancel pending work when virtualization stops', async t => {
  const mounted = [], disposed = [], stops = [], listeners = new Map(), frames = new Map();
  let sequence = 0, reads = 0, observers = 0, scroll = 5000, grid;
  const count = ref(24), enabled = ref(false);
  const cards = () => {
    assert.equal(enabled.value, true, 'disabled grid queried cards'); reads++;
    return Array.from({ length: grid.end.value - grid.start.value }, (_, i) => ({
      dataset: { productIndex: String(grid.start.value + i) }, getBoundingClientRect: () => ({ height: 400 }),
    }));
  };
  const root = ref({ querySelectorAll: cards, getBoundingClientRect: () => {
    assert.equal(enabled.value, true, 'disabled grid measured layout'); reads++;
    return { top: -scroll, width: 390 };
  } });
  const context = { ref, nextTick, watch: (...args) => { stops.push(watch(...args)); },
    onMounted: fn => mounted.push(fn), onBeforeUnmount: fn => disposed.push(fn), onUpdated() {},
    window: { innerHeight: 800, get scrollY() { return scroll; }, scrollBy: ({ top }) => { scroll += top; },
      addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) },
    document: { querySelectorAll: cards }, getComputedStyle: () => ({ gridTemplateColumns: '180px 180px', rowGap: '8px' }),
    requestAnimationFrame: fn => { frames.set(++sequence, fn); return sequence; }, cancelAnimationFrame: id => frames.delete(id),
    ResizeObserver: class { constructor() { observers++; } observe() {} disconnect() { observers--; } },
    IntersectionObserver: class { constructor() { observers++; } observe() {} disconnect() { observers--; } },
  };
  grid = new Function(...Object.keys(context), 'root', 'count', 'enabled', windowCode + '\nreturn useGridWindow(root,count,enabled);')(...Object.values(context), root, () => count.value, () => enabled.value);
  t.after(() => { disposed.forEach(fn => fn()); stops.forEach(stop => stop()); });
  mounted.forEach(fn => fn());
  count.value = 48; await nextTick();
  assert.equal(reads, 0); assert.equal(observers, 0); assert.equal(listeners.size, 0); assert.equal(frames.size, 0);
  assert.equal(grid.end.value, 48);
  count.value = 600; enabled.value = true; await nextTick();
  assert.equal(observers, 2); assert.equal(listeners.size, 2);
  const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn());
  await nextTick();
  assert.ok(reads > 0); assert.ok(grid.start.value > 0); assert.equal(scroll, 5000);
  listeners.get('scroll')();
  const stale = [...frames.values()];
  enabled.value = false; await nextTick();
  const previousReads = reads;
  stale.forEach(fn => fn());
  assert.equal(reads, previousReads); assert.equal(observers, 0); assert.equal(listeners.size, 0); assert.equal(frames.size, 0);
  assert.deepEqual([grid.start.value, grid.end.value, grid.top.value, grid.bottom.value], [0, 600, 0, 0]);
  assert.equal(scroll, 5000);
  enabled.value = true; await nextTick();
  assert.equal(observers, 2); assert.equal(listeners.size, 2); assert.equal(frames.size, 1);
});
test('long feeds bound mounted cards, preserve measured row height while scrolling, and release observers', t => {
  const mounted = [], disposed = [], stops = [], listeners = new Map(), frames = new Map();
  let sequence = 0, scroll = 0, grid;
  const count = ref(600), enabled = ref(true);
  const root = ref({
    getBoundingClientRect: () => ({ top: -scroll, bottom: 122392 - scroll }),
    querySelectorAll: () => Array.from({ length: grid ? grid.end.value - grid.start.value : count.value }, (_, i) => ({
      dataset: { productIndex: String((grid?.start.value ?? 0) + i) }, getBoundingClientRect: () => ({ height: 400 }),
    })),
  });
  let disconnected = 0;
  const context = { ref, nextTick, watch: (...args) => { stops.push(watch(...args)); }, onMounted: fn => mounted.push(fn), onBeforeUnmount: fn => disposed.push(fn), onUpdated() {},
    window: { innerHeight: 800, addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) },
    document: { querySelectorAll: () => root.value.querySelectorAll() },
    getComputedStyle: () => ({ gridTemplateColumns: '180px 180px', rowGap: '8px' }),
    requestAnimationFrame: fn => { const id = ++sequence; frames.set(id, fn); return id; }, cancelAnimationFrame: id => frames.delete(id),
    ResizeObserver: class { observe() {} disconnect() { disconnected++; } }, IntersectionObserver: class { observe() {} disconnect() { disconnected++; } },
  };
  grid = new Function(...Object.keys(context), 'root', 'count', 'enabled', windowCode + '\nreturn useGridWindow(root,count,enabled);')(...Object.values(context), root, () => count.value, () => enabled.value);
  t.after(() => { disposed.forEach(fn => fn()); stops.forEach(stop => stop()); });
  const flush = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(fn => fn()); };
  mounted.forEach(fn => fn()); flush();
  assert.ok(grid.end.value - grid.start.value < 30);
  function height() { const rows = (grid.end.value - grid.start.value) / 2; return grid.top.value + grid.bottom.value + rows * 400 + Math.max(0, rows - 1) * 8 + (grid.top.value ? 8 : 0) + (grid.bottom.value ? 8 : 0); }
  assert.equal(height(), 122392);
  scroll = 50000; listeners.get('scroll')(); flush();
  assert.ok(grid.start.value > 200); assert.ok(grid.end.value - grid.start.value < 40); assert.equal(height(), 122392);
  scroll = 0; listeners.get('scroll')(); flush(); assert.equal(grid.start.value, 0); assert.equal(height(), 122392);
  disposed.forEach(fn => fn()); assert.equal(disconnected, 2); assert.equal(listeners.size, 0); disposed.length = 0;
});

test('changing columns keeps the same visible product and screen position in a long virtual feed', async t => {
  const mounted = [], disposed = [], stops = [], listeners = new Map(), frames = new Map();
  let grid, sequence = 0, scroll = 0, columns = 2, width = 390, height = 400;
  const cards = () => Array.from({ length: grid.end.value - grid.start.value }, (_, offset) => ({
    dataset: { productIndex: String(grid.start.value + offset) },
    getBoundingClientRect: () => ({ height, top: -scroll + (grid.top.value ? grid.top.value + 8 : 0) + Math.floor(offset / columns) * (height + 8) }),
  }));
  const root = ref({ getBoundingClientRect: () => ({ top: -scroll, width }), querySelectorAll: cards,
    querySelector: selector => cards().find(card => selector === `[data-product-index="${card.dataset.productIndex}"]`), contains: () => true });
  const context = { ref, nextTick, watch: (...args) => { stops.push(watch(...args)); }, onMounted: fn => mounted.push(fn), onBeforeUnmount: fn => disposed.push(fn), onUpdated() {},
    window: { innerHeight: 800, get scrollY() { return scroll; }, scrollBy: options => { scroll += options.top; },
      addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) },
    document: { querySelectorAll: cards }, getComputedStyle: () => ({ gridTemplateColumns: Array(columns).fill('180px').join(' '), rowGap: '8px' }),
    requestAnimationFrame: fn => { const id = ++sequence; frames.set(id, fn); return id; }, cancelAnimationFrame: id => frames.delete(id),
    ResizeObserver: class { observe() {} disconnect() {} }, IntersectionObserver: class { observe() {} disconnect() {} },
  };
  grid = new Function(...Object.keys(context), 'root', windowCode + '\nreturn useGridWindow(root,()=>600,()=>true);')(...Object.values(context), root);
  t.after(() => { disposed.forEach(fn => fn()); stops.forEach(stop => stop()); });
  const flush = async () => { for (let step = 0; step < 12 && frames.size; step++) { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(fn => fn()); await nextTick(); } };
  mounted.forEach(fn => fn()); await flush(); scroll = 50000; listeners.get('scroll')(); await flush();
  const anchor = cards().find(card => card.getBoundingClientRect().top >= 160);
  const index = anchor.dataset.productIndex, top = anchor.getBoundingClientRect().top;
  columns = 4; width = 768; height = 320; listeners.get('resize')(); await flush();
  const resized = cards().find(card => card.dataset.productIndex === index);
  assert.ok(resized, 'visible product was unmounted after resize');
  assert.ok(Math.abs(resized.getBoundingClientRect().top - top) < 1, 'visible product moved on screen');
  assert.ok(grid.end.value - grid.start.value < 80);
});
