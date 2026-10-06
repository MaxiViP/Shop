import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { parse, compileScript } from 'vue/compiler-sfc';
import { createSSRApp, defineComponent, h, ref, reactive, computed, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { renderToString } from 'vue/server-renderer';
import ts from 'typescript';
import * as utils from '../app/utils/market-map.ts';

const point = { id: 7, slug: 'fresh-bar', name: 'Fresh Bar', unitNumber: null,
  kind: 'FOODCOURT', description: null, sampleAssortment: 'Гранатовый фреш', photoUrl: null,
  floor: 2, mapX: 33.08, mapY: 70.14, isPublished: true, sortOrder: 1 };
const entrance = { ...point, id: 8, slug: 'entry-butterbrot', kind: 'ENTRY', name: 'Вход на 2 этаж · у ButterBrot', mapX: 41.25, mapY: 52.0548 };
const secondEntry = { ...entrance, id: 9, slug: 'entry-stairs', name: 'Вход на 2 этаж · у Горницы', mapX: 33.9167, mapY: 78.5616 };
const source = await readFile(new URL('../app/components/market/Map.vue', import.meta.url), 'utf8');
const { descriptor } = parse(source, { filename: 'Map.vue' });
const compiled = compileScript(descriptor, { id: 'market-map-test', inlineTemplate: true });
const code = ts.transpileModule(compiled.content, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const nodeRequire = createRequire(import.meta.url);
const module = { exports: {} };
new Function('require', 'exports', 'module', 'ref', 'computed', 'nextTick', 'onMounted', 'onBeforeUnmount', code)(
  id => id === '~/utils/market-map' ? utils : nodeRequire(id),
  module.exports, module, ref, computed, nextTick, onMounted, onBeforeUnmount,
);
const MapComponent = module.exports.default;
async function render(props = {}) {
  const app = createSSRApp(MapComponent, { points: [point, entrance], ...props });
  app.component('UButton', defineComponent({ setup: (_, { slots }) => () => h('button', slots.default?.()) }));
  return renderToString(app);
}

const pageSource = await readFile(new URL('../app/pages/market-map/index.vue', import.meta.url), 'utf8');
const pageScript = compileScript(parse(pageSource, { filename: 'MarketMapPage.vue' }).descriptor,
  { id: 'market-map-page-test', inlineTemplate: true });
const pageCode = ts.transpileModule(pageScript.content, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const { SelectRoot, SelectContent, SelectItem, SelectItemText } = createRequire(import.meta.resolve('@nuxt/ui'))('reka-ui');

async function renderPage(params = {}) {
  const route = reactive({ query: { ...params } }), controls = {}, requests = [], warnings = [];
  const module = { exports: {} };
  const context = {
    require: id => id === '~/utils/market-map' ? utils : id === '~/utils/seo' ? { breadcrumbSchema() {} } : nodeRequire(id),
    exports: module.exports, module, ref, computed, useRoute: () => route,
    useRouter: () => ({ replace: async ({ query }) => {
      route.query = Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined));
    } }),
    useApi: async (path, options) => {
      requests.push({ path, options });
      return { data: ref([point, entrance, { ...point, id: 10, slug: 'shop', kind: 'STORE' }]), error: ref(null), refresh() {} };
    },
    usePageSeo() {}, useJsonLd() {}, apiError: () => '',
  };
  new Function(...Object.keys(context), pageCode)(...Object.values(context));
  const app = createSSRApp(module.exports.default);
  const wrapper = defineComponent({ setup: (_, { slots }) => () => h('div', slots.default?.()) });
  for (const name of ['UContainer', 'UFormField', 'AppBreadcrumbs', 'UButton', 'UAlert']) app.component(name, wrapper);
  app.component('UIcon', defineComponent({ setup: () => () => h('span') }));
  app.component('NuxtLink', defineComponent({ props: ['to'], setup: (props, { slots }) => () => h('a', { href: props.to }, slots.default?.()) }));
  app.component('UInput', defineComponent({ props: ['modelValue'], emits: ['update:modelValue'], setup: (props, { emit }) => {
    controls.search = value => emit('update:modelValue', value);
    return () => h('input', { value: props.modelValue });
  } }));
  app.component('USelect', defineComponent({ props: ['items', 'modelValue'], emits: ['update:modelValue'], setup: (props, { emit }) => {
    controls.items = props.items;
    controls.selected = props.modelValue;
    controls.select = value => emit('update:modelValue', value);
    return () => h(SelectRoot, { modelValue: props.modelValue }, {
      default: () => h(SelectContent, { forceMount: true }, {
        default: () => props.items.map(item => h(SelectItem, { value: item.value }, {
          default: () => h(SelectItemText, () => item.label),
        })),
      }),
    });
  } }));
  app.component('MarketMap', defineComponent({ props: ['points', 'selectedId'], setup: props => () => {
    controls.points = props.points;
    return h(MapComponent, props);
  } }));
  app.config.warnHandler = message => warnings.push(message);
  return { html: await renderToString(app), route, controls, requests, warnings };
}

test('Market Map page SSR renders default filters with real SelectItem components', async () => {
  const page = await renderPage();
  assert.equal(page.controls.selected, 'all');
  assert.deepEqual(page.warnings, []);
  assert.ok(page.controls.items.every(item => typeof item.value === 'string' && item.value.length > 0));
  assert.ok(page.html.includes('Все точки'));
  assert.ok(page.html.includes('Лавки и магазины'));
  assert.deepEqual(page.requests, [{ path: '/market-map', options: { query: { floor: 2 } } }]);
  assert.deepEqual(page.controls.points.map(row => row.slug), ['fresh-bar', 'shop', 'entry-butterbrot']);
});

test('every Market Map Select option is nonempty and survives selection and hard reload', async () => {
  const page = await renderPage({ point: point.slug });
  assert.deepEqual(page.controls.items.map(item => item.value),
    ['all', ...utils.marketKinds.filter(item => item.value !== 'ENTRY').map(item => item.value)]);
  for (const item of page.controls.items) {
    page.controls.select(item.value);
    const reloaded = await renderPage(page.route.query);
    assert.equal(reloaded.controls.selected, item.value);
    assert.deepEqual(reloaded.warnings, []);
    assert.equal(page.route.query.point, point.slug);
    if (item.value === 'all') assert.ok(!Object.hasOwn(page.route.query, 'kind'));
    else {
      assert.equal(page.route.query.kind, item.value);
      assert.ok(reloaded.controls.points.every(row => row.kind === item.value || row.kind === 'ENTRY'));
    }
    assert.deepEqual(reloaded.requests[0].options.query, { floor: 2 });
  }
});

test('all clears the kind filter, keeps the selected point and restores search from the URL', async () => {
  const page = await renderPage({ point: point.slug, kind: 'FOODCOURT', q: 'Fresh' });
  assert.equal(page.controls.selected, 'FOODCOURT');
  assert.match(page.html, /value="Fresh"/);
  assert.deepEqual(page.controls.points.map(row => row.slug), [point.slug, entrance.slug]);
  page.controls.select('all');
  assert.deepEqual(page.route.query, { point: point.slug, q: 'Fresh' });
  page.controls.search('');
  assert.deepEqual(page.route.query, { point: point.slug });
  const reloaded = await renderPage(page.route.query);
  assert.equal(reloaded.controls.selected, 'all');
  assert.deepEqual(reloaded.controls.points.map(row => row.slug), [point.slug, 'shop', entrance.slug]);
  for (const kind of ['', 'all', 'invalid', 'ENTRY', ['STORE', 'STALL']]) {
    assert.equal((await renderPage({ kind })).controls.selected, 'all');
  }
  assert.ok(utils.marketKinds.every(item => item.value.length > 0), 'ADMIN uses the same nonempty types');
});

test('the original floor asset is present, scalable and self-contained', async () => {
  const svg = await readFile(new URL('../public/images/market/floor2.svg', import.meta.url), 'utf8');
  assert.match(svg, /viewBox="0 0 1200 1460"/);
  assert.ok(svg.includes('Схема второго этажа'));
  assert.ok(!/<script|<foreignObject|<image|https?:\/\//.test(svg.replace('http://www.w3.org/2000/svg', '')));
  const blocks = [...svg.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)"/g)]
    .map(match => ({ x: +match[1], y: +match[2], width: +match[3], height: +match[4] }));
  assert.ok(blocks.length > 50, 'floor plan has trading blocks and aisles');
  const contains = (x, y) => blocks.some(block => x >= block.x && x <= block.x + block.width
    && y >= block.y && y <= block.y + block.height);
  for (const [x, y] of [[397, 1024], [548, 745], [631, 791]])
    assert.ok(contains(x, y), 'Fresh Bar, ButterBrot and sausages markers belong to their blocks');
  assert.equal(contains(495, 760), false, 'first entry is in the interior aisle');
  assert.equal(contains(407, 1147), true, 'second entry is in the stair/escalator block');
});

function interactionFixture(view, editable = true, placing = false) {
  const mounted = [], unmounted = [], events = [];
  const parsed = ts.createSourceFile('map.ts', descriptor.scriptSetup.content, ts.ScriptTarget.Latest, true);
  let script = descriptor.scriptSetup.content;
  for (const statement of [...parsed.statements].reverse()) if (ts.isImportDeclaration(statement))
    script = script.slice(0, statement.getStart()) + script.slice(statement.end);
  const executable = ts.transpileModule(script, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  let observed = false, disconnected = false;
  const context = { ...utils, ref, computed, nextTick,
    defineProps: () => ({ points: [point, entrance, secondEntry], editable, placing }),
    withDefaults: (props, defaults) => ({ ...defaults, ...props }),
    defineEmits: () => (name, ...args) => events.push([name, ...args]),
    onMounted: callback => mounted.push(callback), onBeforeUnmount: callback => unmounted.push(callback),
    ResizeObserver: class { observe() { observed = true; } disconnect() { disconnected = true; } },
    DOMPoint: class {
      constructor(x, y) { this.x = x; this.y = y; }
      matrixTransform(m) { return { x: m.a * this.x + m.c * this.y + m.e, y: m.b * this.x + m.d * this.y + m.f }; }
    },
  };
  const map = new Function(...Object.keys(context), executable + '\nreturn { viewport, drawing, zoom, fitWidth, changeZoom, reset, fit, place, select, keySelect };')(...Object.values(context));
  map.viewport.value = {
    clientWidth: view.width, clientHeight: view.height, scrollLeft: 0, scrollTop: 0,
    get scrollWidth() { return Math.max(view.width, map.fitWidth.value * map.zoom.value); },
    get scrollHeight() { return Math.max(view.height, map.fitWidth.value * map.zoom.value * utils.mapSize.height / utils.mapSize.width); },
  };
  mounted.forEach(callback => callback());
  return { map, events, observed: () => observed, close: () => { unmounted.forEach(callback => callback()); return disconnected; } };
}

test('mobile and desktop fit/zoom/pan reset stay bounded and release their observer', async () => {
  for (const view of [{ width: 320, height: 400 }, { width: 1024, height: 730 }]) {
    const fixture = interactionFixture(view), { map } = fixture;
    assert.ok(map.fitWidth.value <= view.width);
    assert.ok(map.fitWidth.value * utils.mapSize.height / utils.mapSize.width <= view.height + .01);
    for (let i = 0; i < 20; i++) await map.changeZoom(.5);
    assert.equal(map.zoom.value, 5);
    for (let i = 0; i < 20; i++) await map.changeZoom(-.5);
    assert.equal(map.zoom.value, 1);
    await map.changeZoom(1); await map.reset();
    assert.equal(map.zoom.value, 1);
    assert.equal(map.viewport.value.scrollLeft, 0);
    assert.equal(map.viewport.value.scrollTop, 0);
    assert.ok(fixture.observed());
    assert.ok(fixture.close());
  }
});

function logicalCenter(map) {
  const viewport = map.viewport.value;
  const width = map.fitWidth.value * map.zoom.value;
  const left = Math.max(0, (viewport.clientWidth - width) / 2) - viewport.scrollLeft;
  const top = -viewport.scrollTop;
  return {
    x: (viewport.clientWidth / 2 - left) * utils.mapSize.width / width,
    y: (viewport.clientHeight / 2 - top) * utils.mapSize.width / width,
  };
}

function assertCenter(map, expected) {
  const actual = logicalCenter(map);
  assert.ok(Math.abs(actual.x - expected.x) < .001, `center x: ${actual.x} vs ${expected.x}`);
  assert.ok(Math.abs(actual.y - expected.y) < .001, `center y: ${actual.y} vs ${expected.y}`);
}

test('zoom from 100 to 200 percent preserves the viewport logical center', async () => {
  for (const view of [{ width: 320, height: 400 }, { width: 1024, height: 730 }]) {
    const fixture = interactionFixture(view), { map } = fixture;
    const center = logicalCenter(map);
    await map.changeZoom(1);
    assert.equal(map.zoom.value, 2);
    assertCenter(map, center);
    fixture.close();
  }
});

test('zoom preserves the current center after horizontal and vertical pan', async () => {
  const fixture = interactionFixture({ width: 390, height: 450 }), { map } = fixture;
  await map.changeZoom(1);
  map.viewport.value.scrollLeft = 130;
  map.viewport.value.scrollTop = 290;
  const center = logicalCenter(map);
  await map.changeZoom(1);
  assert.equal(map.zoom.value, 3);
  assertCenter(map, center);
  await map.changeZoom(-.5);
  assertCenter(map, center);
  fixture.close();
});

test('zoom clamps scroll to the available viewport bounds', async () => {
  const fixture = interactionFixture({ width: 390, height: 450 }), { map } = fixture;
  await map.changeZoom(2);
  for (const edge of ['start', 'end']) {
    const viewport = map.viewport.value;
    viewport.scrollLeft = edge === 'start' ? 0 : viewport.scrollWidth - viewport.clientWidth;
    viewport.scrollTop = edge === 'start' ? 0 : viewport.scrollHeight - viewport.clientHeight;
    await map.changeZoom(-1);
    assert.equal(viewport.scrollLeft, edge === 'start' ? 0 : viewport.scrollWidth - viewport.clientWidth);
    assert.equal(viewport.scrollTop, edge === 'start' ? 0 : viewport.scrollHeight - viewport.clientHeight);
    await map.changeZoom(1);
  }
  fixture.close();
});

test('whole-map reset restores 100 percent zoom and clears pan after layout updates', async () => {
  const fixture = interactionFixture({ width: 390, height: 450 }), { map } = fixture;
  await map.changeZoom(2);
  map.viewport.value.scrollLeft = 180;
  map.viewport.value.scrollTop = 370;
  await map.reset();
  assert.equal(map.zoom.value, 1);
  assert.equal(map.viewport.value.scrollLeft, 0);
  assert.equal(map.viewport.value.scrollTop, 0);
  fixture.close();
});

test('infrastructure landmarks are static SVG labels without point navigation', async () => {
  const svg = await readFile(new URL('../public/images/market/floor2.svg', import.meta.url), 'utf8');
  assert.match(svg, /<text\b[^>]*>Эскалатор<\/text>/);
  assert.match(svg, /<text\b[^>]*>Лифт<\/text>/);
  assert.ok(!/<a\b|href=|data-point/.test(svg));
  assert.deepEqual(utils.filterMarketPoints([point, entrance, secondEntry], 'Эскалатор'), []);
  assert.deepEqual(utils.filterMarketPoints([point, entrance, secondEntry], 'Лифт'), []);
});

test('ENTRY placement uses the real screen transform after pan/zoom and keyboard selects the point', () => {
  const fixture = interactionFixture({ width: 390, height: 450 }), { map } = fixture;
  // One screen pixel represents two map units, with a panned viewport offset.
  map.drawing.value = { getScreenCTM: () => ({ inverse: () => ({ a: 2, b: 0, c: 0, d: 2, e: 300, f: 400 }) }) };
  // Placing is disabled until ADMIN explicitly enables it.
  map.place({ clientX: 100, clientY: 200 });
  assert.deepEqual(fixture.events, []);
  let prevented = false;
  map.keySelect({ key: ' ', preventDefault: () => { prevented = true; } }, 8);
  assert.ok(prevented);
  assert.deepEqual(fixture.events, [['select', 8]]);
  fixture.close();
  const placing = interactionFixture({ width: 390, height: 450 }, true, true);
  placing.map.drawing.value = { getScreenCTM: () => ({ inverse: () => ({ a: 2, b: 0, c: 0, d: 2, e: 300, f: 400 }) }) };
  let stopped = false;
  placing.map.select({ clientX: 97.5, clientY: 180, stopPropagation: () => { stopped = true; } }, 8);
  assert.ok(stopped);
  assert.deepEqual(placing.events, [['place', { mapX: 41.25, mapY: 52.05 }]]);
  placing.close();
  const readonly = interactionFixture({ width: 1024, height: 730 }, false, true);
  readonly.map.place({ clientX: 97.5, clientY: 180 });
  assert.deepEqual(readonly.events, []);
  readonly.close();
});

test('map SSR renders point links and entrance arrows without an optional unit number', async () => {
  const html = await render();
  assert.match(html, /href="\/market-map\/fresh-bar"/);
  assert.match(html, /href="\/market-map\/entry-butterbrot"/);
  assert.ok(html.includes('Вход на 2 этаж'));
  assert.ok(html.includes('map__arrow'));
  assert.ok(!html.includes('null') && !html.includes('undefined'));
  assert.ok(html.includes('href="/images/market/floor2.svg"'));
  assert.ok(!html.includes('<iframe'));
});

test('two interior ENTRY markers have prominent zones and captions at their real coordinates', async () => {
  const html = await render({ points: [point, entrance, secondEntry] });
  assert.equal((html.match(/class="map__entry-zone"/g) ?? []).length, 2);
  assert.equal((html.match(/class="map__entry-label"/g) ?? []).length, 2);
  assert.ok(html.includes('href="/market-map/entry-stairs"'));
  assert.ok(!html.includes('cy="-21"'));
  const markers = utils.mapLabels([point, entrance, secondEntry]);
  assert.deepEqual(markers.slice(-2).map(marker => marker.point.kind), ['ENTRY', 'ENTRY']);
  for (const marker of markers.filter(marker => marker.point.kind === 'ENTRY')) {
    assert.deepEqual(marker.lines, ['Вход на 2 этаж']);
    assert.ok(marker.caption.width >= 126);
  }
});

test('numbered, highlighted and hidden markers render correctly with escaped ADMIN text', async () => {
  const html = await render({ points: [{ ...point, name: '<script>unsafe</script>', unitNumber: 'Д1', isPublished: false }], selectedId: 7 });
  assert.ok(html.includes('Д1'));
  assert.ok(html.includes('map__point--selected'));
  assert.ok(html.includes('map__point--hidden'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>'));
});

test('ADMIN markers use keyboard buttons instead of public navigation', async () => {
  const html = await render({ editable: true, placing: true });
  assert.match(html, /role="button" tabindex="0"/);
  assert.ok(!html.includes('href="/market-map/fresh-bar"'));
  assert.ok(html.includes('Нажмите на схему'));
  assert.ok(html.includes('map__viewport--placing'));
});

test('market search is insensitive, supports numbers/types and excludes entrance duplicates', () => {
  const numbered = { ...point, id: 9, slug: 'fruit', name: 'Фрукты', unitNumber: 'Б2', kind: 'STALL', sampleAssortment: 'Яблоки' };
  const rows = [point, entrance, numbered];
  assert.deepEqual(utils.filterMarketPoints(rows, ' FRESH '), [point]);
  assert.deepEqual(utils.filterMarketPoints(rows, 'б2'), [numbered]);
  assert.deepEqual(utils.filterMarketPoints(rows, 'ЯБЛОКИ'), [numbered]);
  assert.deepEqual(utils.filterMarketPoints(rows, '', 'FOODCOURT'), [point]);
  assert.deepEqual(utils.filterMarketPoints(rows, 'не существует'), []);
  assert.deepEqual(utils.filterMarketPoints(rows, ''), [point, numbered]);
});

test('position conversion is independent of view size and constrains placement to the map', () => {
  assert.deepEqual(utils.mapPosition(600, 730), { mapX: 50, mapY: 50 });
  assert.deepEqual(utils.mapPosition(-10, 1600), { mapX: 0, mapY: 100 });
  assert.equal(utils.mapPosition(NaN, 1), null);
  assert.equal(utils.mapPosition(1, Infinity), null);
  assert.equal(utils.marketPointLabel(point), 'Fresh Bar');
  assert.equal(utils.marketPointLabel({ ...point, unitNumber: 'Д1' }), 'Д1 · Fresh Bar');
  assert.ok(utils.mapLabelLines('Очень длинное название лавки на рынке').length <= 3);
  assert.ok(utils.mapLabelLines('д'.repeat(100)).every(line => line.length <= 15));
});

test('dense captions do not overlap while each marker keeps its physical map coordinates', () => {
  const rows = [
    { ...point, id: 1, name: 'Белорусские колбасы', mapX: 631 / 12, mapY: 791 / 14.6 },
    { ...point, id: 2, name: 'Тамбовское домашнее сало', mapX: 678 / 12, mapY: 800 / 14.6 },
    { ...point, id: 3, name: 'Стейк’Хэм Бургерс', mapX: 672 / 12, mapY: 743 / 14.6 },
    { ...point, id: 4, name: 'Русские традиции', mapX: 433 / 12, mapY: 883 / 14.6 },
    { ...point, id: 5, name: 'Кулинария', mapX: 473 / 12, mapY: 879 / 14.6 },
    { ...point, id: 6, name: 'Рязанская молочная продукция', mapX: 472 / 12, mapY: 918 / 14.6 },
  ];
  const labels = utils.mapLabels(rows);
  assert.equal(labels.length, rows.length);
  for (const marker of labels) {
    assert.ok(Math.abs(marker.x - marker.point.mapX * 12) < .01);
    assert.ok(Math.abs(marker.y - marker.point.mapY * 14.6) < .01);
  }
  assert.ok(labels.some(marker => marker.displaced));
  const areas = labels.map(({ x, y, lines, label }) => {
    const width = Math.max(...lines.map(line => line.length)) * 8;
    const left = x + label.x - (label.anchor === 'end' ? width : label.anchor === 'middle' ? width / 2 : 0);
    return { left, right: left + width, top: y + label.y - 13, bottom: y + label.y + (lines.length - 1) * 17 + 4 };
  });
  for (let i = 0; i < areas.length; i++) for (let j = i + 1; j < areas.length; j++) {
    const a = areas[i], b = areas[j];
    assert.ok(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
  }
});

test('placement accounts for actual zoom/pan transform and emits once on a marker click', () => {
  assert.match(source, /getScreenCTM\(\)/);
  assert.match(source, /matrixTransform\(matrix.inverse\(\)\)/);
  const select = source.slice(source.indexOf('function select('), source.indexOf('function keySelect('));
  assert.ok(select.indexOf('event.stopPropagation()') < select.indexOf('if (props.placing)'));
  assert.match(source, /\['Enter', ' '\]\.includes\(event.key\)/);
  assert.match(source, /event.preventDefault\(\)/);
  assert.match(source, /observer\?\.disconnect\(\)/);
  assert.match(source, /overflow: auto/);
  assert.match(source, /min-height: 44px/);
});

test('public pages and ADMIN editor keep route/access/content contracts', async () => {
  const read = file => readFile(new URL(`../app/${file}`, import.meta.url), 'utf8');
  const [map, detail, admin, header, layout] = await Promise.all([
    'pages/market-map/index.vue', 'pages/market-map/[slug].vue', 'pages/admin/market-map.vue',
    'components/app/Header.vue', 'layouts/admin.vue',
  ].map(read));
  assert.match(admin, /definePageMeta\(\{ middleware: 'admin', layout: 'admin' \}\)/);
  assert.match(admin, /Номер точки/);
  assert.match(admin, /\/admin\/market-map\/points/);
  assert.match(admin, /@place="place"/);
  assert.match(admin, /:model-value="form.floor" readonly/);
  for (const field of ['mapX', 'mapY'])
    assert.match(admin, new RegExp(`v-model.number="form.${field}"[^>]+step="any"`));
  assert.match(detail, /v-if="point.unitNumber"/);
  assert.match(detail, /Ассортимент может меняться/);
  assert.match(detail, /Примерный ассортимент/);
  assert.match(detail, /актуальный ассортимент и наличие уточните в чате/);
  assert.match(detail, /гранатовый фреш/);
  assert.match(detail, /Фото точки появится позже/);
  assert.match(map, /Аутентичный поход на рынок/);
  assert.match(header, /to="\/market-map"/);
  assert.match(layout, /to: '\/admin\/market-map'/);
  for (const page of [map, detail, admin]) {
    assert.ok(page.indexOf('<template>') < page.indexOf('<script setup lang="ts">'));
    assert.ok(page.indexOf('<script setup lang="ts">') < page.indexOf('<style scoped>'));
  }
});
