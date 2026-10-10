import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { parse, compileScript } from 'vue/compiler-sfc';
import { createSSRApp, defineComponent, h, ref, reactive, computed, watch, nextTick, shallowRef, toValue, onMounted, onBeforeUnmount } from 'vue';
import { renderToString } from 'vue/server-renderer';
import ts from 'typescript';
import * as money from '../app/utils/money.ts';
import * as quantity from '../app/utils/assembly.ts';
import { qtyText } from '../app/utils/qty.ts';
import { quickAddState } from '../app/utils/quick-add.ts';
import { nextCartQty, previousCartQty, previewTotal, validCartQty } from '../app/utils/cart.ts';
import { priceStatusItems } from '../app/utils/price-status.ts';
import { moscowInput, pickupDate } from '../app/utils/pickup.ts';
import { useProductGallery } from '../app/composables/useProductGallery.ts';

const nodeRequire = createRequire(import.meta.url);
const source = file => readFile(new URL(`../app/${file}`, import.meta.url), 'utf8');
const product = { id: 1, name: 'Рис Casa Rinaldi Карнароли 500 г', slug: 'cezoni-market-casa-rinaldi-carnaroli-500g',
  price: 24200, priceStatus: 'SOURCE', priceQty: 1, unit: 'PIECE', step: 1, min: 1, portionQty: 1, images: [], description: null,
  category: { name: 'Макароны и крупы', slug: 'pasta-grains' }, marketPoint: { name: 'Cezoni Market', slug: 'cezoni-market' } };
const cart = { restored: true, serverBusy: false, quoteReady: true, items: [], qty: () => 0, displayLineTotal: () => null };

const modules = {
  '~/utils/money': money,
  '~/utils/qty': { qtyText },
  '~/utils/quick-add': { quickAddState },
  '~/utils/cart': { nextCartQty, previousCartQty, previewTotal, validCartQty },
  '~/stores/cart': { useCartStore: () => cart },
  '~/utils/seo': { breadcrumbSchema() {}, productSchema() {}, productSeo() {} },
  '~/utils/price-status': { priceStatusItems },
};
async function component(file) {
  const { descriptor } = parse(await source(file), { filename: file });
  const compiled = compileScript(descriptor, { id: file, inlineTemplate: true });
  const code = ts.transpileModule(compiled.content, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  const context = { require: id => modules[id] ?? nodeRequire(id), exports: module.exports, module,
    computed, ref, watch, onMounted, onBeforeUnmount, useProductGallery, useRoute: () => ({ params: { slug: product.slug } }),
    useGridWindow: () => ({ start: ref(0), end: ref(120), top: ref(0), bottom: ref(0) }),
    useCartActions: () => ({ add: async () => true, subtract: async () => true }),
    useAsset: () => value => value, useHeaderNotice: () => ({ show() {} }),
    useApi: async () => ({ data: ref(product), error: ref(null) }),
    usePageSeo() {}, useJsonLd() {}, createError: value => new Error(value.statusMessage),
  };
  new Function(...Object.keys(context), code)(...Object.values(context));
  return module.exports.default;
}
const Origin = await component('components/product/Origin.vue');
const Price = await component('components/product/Price.vue');
const Card = await component('components/product/Card.vue');
const Grid = await component('components/product/Grid.vue');
const Detail = await component('pages/product/[slug].vue');
const Gallery = await component('components/product/Gallery.vue');
const wrapper = defineComponent({ setup: (_, { slots }) => () => h('div', slots.default?.()) });
const link = defineComponent({ props: ['to'], setup: (props, { slots }) => () => h('a', { href: props.to }, slots.default?.()) });
async function render(Component, props = {}) {
  const app = createSSRApp(Component, props);
  app.component('NuxtLink', link);
  app.component('ProductOrigin', Origin);
  app.component('ProductPrice', Price);
  app.component('ProductCard', Card);
  app.component('ProductGallery', Gallery);
  for (const name of ['UButton', 'UContainer', 'UAlert', 'UIcon', 'ProductFavorite', 'ProductQty', 'AppBreadcrumbs', 'AppBackButton'])
    app.component(name, wrapper);
  return renderToString(app);
}

test('product card renders backend customer price once, market link and a calm note with no borrowed image', async () => {
  const html = await render(Card, { product });
  assert.ok(html.includes('242 ₽'));
  assert.ok(!html.includes('266'));
  assert.ok(html.includes('Фото скоро'));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('Где покупаем:'));
  assert.match(html, /href="\/market-map\/cezoni-market"/);
  assert.ok(html.includes('Cezoni Market'));
  assert.ok(html.includes('Цена по открытому источнику и может измениться при сборке.'));
  assert.ok(!html.includes('sourceUrl') && !html.includes('220 ₽') && !html.includes('role="alert"'));
});

test('product detail renders the same customer price, purchase total and market point link', async () => {
  const html = await render(Detail);
  assert.ok(html.includes(product.name));
  assert.ok(html.includes('В корзину · 242 ₽'));
  assert.match(html, /href="\/market-map\/cezoni-market"/);
  assert.ok(html.includes('Цена по открытому источнику и может измениться при сборке.'));
});

test('catalog cards and actual detail gallery display the backend photo URL without depending on staging', async t => {
  const image = { url: '/uploads/products/00000000-0000-8000-8000-000000000001.webp', alt: 'Product illustration' };
  product.images = [image];
  t.after(() => { product.images = []; });
  for (const html of [await render(Card, { product }), await render(Detail)]) {
    assert.ok(html.includes(`src="${image.url}"`) && html.includes(`alt="${image.alt}"`));
    assert.ok(!html.includes('Фото скоро') && !html.includes('product-photo-source'));
    assert.ok(html.includes('242 ₽') && !html.includes('220 ₽'));
  }
});

test('nullable market relation keeps old cards usable; Grand Bazar gets its own link', async () => {
  const old = await render(Card, { product: { ...product, marketPoint: null } });
  assert.ok(old.includes('242 ₽'));
  assert.ok(!old.includes('Где покупаем:'));
  const grand = await render(Origin, { point: { slug: 'grand-bazar', name: 'Гранд Базар' } });
  assert.match(grand, /href="\/market-map\/grand-bazar"/);
  assert.ok(grand.includes('Гранд Базар'));
  assert.ok(!(await render(Origin)).includes('<a'));
});

test('seasonal and hit ribbons coexist on the shared card without changing its price or click targets', async () => {
  for (const [isSeasonal, isHit] of [[false, false], [true, false], [false, true], [true, true]]) {
    const html = await render(Card, { product: { ...product, isSeasonal, isHit } });
    assert.equal(html.includes('card__ribbon--season'), isSeasonal);
    assert.equal(html.includes('card__ribbon--hit'), isHit);
    assert.equal(html.includes('card__media--badged'), isSeasonal || isHit);
    assert.ok(html.includes('242 ₽'));
    assert.match(html, new RegExp('href="/product/' + product.slug + '"'));
  }
  const css = parse(await source('components/product/Card.vue')).descriptor.styles[0].content;
  assert.match(css, /\.card__ribbon--season\s*\{\s*background:\s*#15803d/);
  assert.match(css, /\.card__ribbon--hit\s*\{\s*background:\s*#b45309/);
  assert.match(css, /\.card__badges\s*\{[^}]*pointer-events:\s*none/);
  assert.match(css, /\.card__media\s*\{[^}]*position:\s*relative/);
  assert.match(css, /\.card__badges\s*\{[^}]*position:\s*absolute[^}]*left:\s*0[^}]*display:\s*grid/);
  assert.match(css, /\.card__media--badged \.card__quantity\s*\{[^}]*top:\s*auto[^}]*bottom:\s*var\(--card-inset\)/);
});

test('HTTP product badges reach the shared photo card through home, search and infinite catalog feeds', async t => {
  const marked = { ...product, isHit: true, isSeasonal: true, seasonalStartsAt: null, seasonalEndsAt: null,
    images: [{ url: '/uploads/products/marked-product.webp', alt: product.name }] };
  const requests = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    requests.push(Object.fromEntries(url.searchParams));
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ items: url.searchParams.has('cursor') ? [marked]
      : [{ ...product, id: 2, slug: 'unmarked-product', isHit: false, isSeasonal: false }],
    total: 2, nextCursor: url.searchParams.has('cursor') ? null : 'badge-page-2', page: 1, limit: 24, pages: 1 }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  let feedSource = await source('composables/useProductFeed.ts');
  const ast = ts.createSourceFile('useProductFeed.ts', feedSource, ts.ScriptTarget.Latest, true);
  for (const statement of [...ast.statements].reverse()) if (ts.isImportDeclaration(statement))
    feedSource = feedSource.slice(0, statement.getStart()) + feedSource.slice(statement.end);
  const code = ts.transpileModule(feedSource.replace(/^export /gm, ''), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const descendants = node => [node, ...(node.children ?? []).flatMap(descendants)];
  const hasClass = (node, name) => node.props?.some(prop => prop.name === 'class' && prop.value?.content.split(/\s+/).includes(name));
  for (const query of [{ feed: 'home', limit: 24 }, { feed: 'catalog', limit: 24 }, { feed: 'catalog', q: product.name, limit: 24 }]) {
    const stops = [];
    t.after(() => stops.reverse().forEach(stop => stop()));
    const api = async (path, { query }) => (await fetch(`${base}${path}?${new URLSearchParams(query)}`)).json();
    const context = { ref, shallowRef, computed, toValue,
      watch: (...args) => { const stop = watch(...args); stops.push(stop); return stop; },
      onScopeDispose: stop => stops.push(stop), useApiClient: () => api,
      useApi: async (path, options) => ({ data: ref(await api(path, { query: options.query.value })), error: ref(null) }) };
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const create = await new AsyncFunction(...Object.keys(context), code + '\nreturn useProductFeed;')(...Object.values(context));
    const feed = await create(query, 'badge-' + query.feed);
    await feed.loadMore();
    assert.deepEqual(feed.items.value.map(item => item.id), [2, marked.id]);
    assert.equal(feed.hasMore.value, false);
    const delivered = feed.items.value.find(item => item.id === marked.id);
    assert.equal(delivered.isHit, true); assert.equal(delivered.isSeasonal, true);
    assert.equal(delivered.price, marked.price);
    const beforeRender = requests.length;
    for (const compact of [false, true]) {
      const html = await render(Grid, { items: feed.items.value, compact, windowed: true });
      const tree = parse(`<template>${html}</template>`).descriptor.template.ast;
      const markedCard = descendants(tree).find(node => hasClass(node, 'card') &&
        descendants(node).some(child => child.props?.some(prop => prop.name === 'href' && prop.value?.content === `/product/${marked.slug}`)));
      assert.ok(markedCard);
      const media = descendants(markedCard).find(node => hasClass(node, 'card__media'));
      assert.ok(media);
      const ribbons = descendants(media).filter(node => hasClass(node, 'card__ribbon'));
      assert.equal(ribbons.length, 2, 'Both API badges must be inside the positioned photo, not the card body');
      assert.deepEqual(ribbons.map(node => node.children.find(child => child.type === 2)?.content.trim()).toSorted(), ['СЕЗОН', 'ХИТ'].toSorted());
      const body = descendants(markedCard).find(node => hasClass(node, 'card__body'));
      assert.equal(descendants(body).filter(node => hasClass(node, 'card__ribbon')).length, 0);
      assert.match(html, /src="\/uploads\/products\/marked-product.webp"/);
    }
    assert.equal(requests.length, beforeRender, 'Rendering cards must not make per-product requests');
  }
  assert.equal(requests.length, 6, 'Each feed uses one initial request and one cursor request');
});

test('a compact card keeps both ribbons and its cart quantity in separate photo positions', async () => {
  const previousQty = cart.qty;
  cart.qty = () => 1;
  try {
    const html = await render(Card, { product: { ...product, isHit: true, isSeasonal: true }, compact: true });
    assert.ok(html.includes('card__media--badged'));
    assert.ok(html.includes('card__ribbon--hit') && html.includes('card__ribbon--season'));
    assert.ok(html.includes('card__quantity') && html.includes('card__control'));
    const css = parse(await source('components/product/Card.vue')).descriptor.styles[0].content;
    assert.match(css, /\.card__favorite\s*\{[^}]*right:\s*0\.25rem/);
    assert.match(css, /\.card__badges\s*\{[^}]*top:\s*var\(--card-inset\)[^}]*left:\s*0/);
    assert.match(css, /\.card__media--badged \.card__quantity\s*\{[^}]*bottom:\s*var\(--card-inset\)[^}]*transform:\s*translateX\(-50%\)/);
  } finally { cart.qty = previousQty; }
});

test('estimated and audited product cards render their own price provenance without exposing seller price', async () => {
  const estimated = await render(Card, { product: { ...product, priceStatus: 'ESTIMATED' } });
  assert.ok(estimated.includes('Ориентировочная цена. Актуальную стоимость продавец подтвердит при сборке.'));
  const audited = await render(Card, { product: { ...product, priceStatus: 'AUDITED' } });
  assert.ok(!audited.includes('Ориентировочная цена') && !audited.includes('Цена по открытому источнику'));
  for (const html of [estimated, audited]) {
    assert.ok(html.includes('242 ₽') && !html.includes('220 ₽'));
    assert.ok(!html.includes('<img'));
  }
});

test('market point listing requests associated products and renders the normal product grid', async () => {
  const page = await source('pages/market-map/[slug].vue');
  assert.match(page, /marketPoint: slug\.value/);
  assert.match(page, /<ProductGrid :items="products\.items"/);
});

test('admin edits and resaves seller price, and requests customer price from the backend', async t => {
  const { descriptor } = parse(await source('components/admin/ProductForm.vue'));
  const parsed = ts.createSourceFile('form.ts', descriptor.scriptSetup.content, ts.ScriptTarget.Latest, true);
  let script = descriptor.scriptSetup.content;
  for (const statement of [...parsed.statements].reverse()) if (ts.isImportDeclaration(statement))
    script = script.slice(0, statement.getStart()) + script.slice(statement.end);
  const code = ts.transpileModule(script, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const admin = { ...product, price: 22000, sellerPrice: 22000, customerPrice: 24200, serviceMarkup: 2200,
    serviceMarkupPercent: 10, categoryId: 1, marketPointId: 10, sourceUrl: 'https://cezoni.com/collection/all',
    sourceCheckedAt: '2026-10-06T00:00:00.000Z', settlementMode: 'UNSET', basePrice: null, active: true, sort: 1 };
  const requests = [], stops = [];
  t.after(() => stops.forEach(stop => stop()));
  const context = { ref, reactive, computed, ...money, ...quantity, qtyText, priceStatusItems, moscowInput, pickupDate,
    defineProps: () => ({ product: admin, categories: [{ id: 1, name: 'Макароны и крупы', active: true }] }),
    defineEmits: () => () => {},
    watch: (...args) => { const stop = watch(...args); stops.push(stop); return stop; },
    useApi: async path => {
      if (path === '/admin/seasons') return { data: ref([]) };
      assert.equal(path, '/admin/market-map/points');
      return { data: ref([{ id: 10, slug: 'cezoni-market', name: 'Cezoni Market', kind: 'STORE' }]) };
    },
    useApiClient: () => async (path, options) => {
      requests.push({ path, ...options });
      if (path === '/admin/products/pricing') {
        assert.deepEqual(options.body, { price: 49500 });
        return { sellerPrice: 49500, serviceMarkupPercent: 10, serviceMarkup: 4950, customerPrice: 54450 };
      }
      return admin;
    },
    useToast: () => ({ add() {} }), apiError: value => String(value),
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const form = await new AsyncFunction(...Object.keys(context), code + '\nreturn { save, rubles, pricing, pointItems };')(...Object.values(context));
  assert.equal(form.rubles.value, '220.00');
  assert.equal(form.pricing.value.customerPrice, 24200);
  await form.save(); await form.save();
  assert.ok(requests.every(request => request.body.price === 22000));
  assert.equal(requests[0].body.marketPointId, 10);
  assert.equal(requests[0].body.sourceCheckedAt, '2026-10-06T00:00:00.000Z');
  assert.equal(admin.price, 22000);
  form.rubles.value = '495'; await nextTick();
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(form.pricing.value.customerPrice, 54450);
  assert.equal(requests.at(-1).path, '/admin/products/pricing');
  assert.ok(!Object.hasOwn(requests[0].body, 'customerPrice'));
});

async function priceEditor(item) {
  const { descriptor } = parse(await source('components/order/ItemPrice.vue'));
  const parsed = ts.createSourceFile('price.ts', descriptor.scriptSetup.content, ts.ScriptTarget.Latest, true);
  let script = descriptor.scriptSetup.content;
  for (const statement of [...parsed.statements].reverse()) if (ts.isImportDeclaration(statement))
    script = script.slice(0, statement.getStart()) + script.slice(statement.end);
  const code = ts.transpileModule(script, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const requests = [];
  const context = { ref, ...money, qtyText,
    defineProps: () => ({ item, orderId: 1, editable: true, disabled: false }),
    defineEmits: () => () => {}, useToast: () => ({ add() {} }), apiError: value => String(value),
    useApiClient: () => async (path, options) => {
      requests.push({ path, ...options });
      item.actualSellerPrice = options.body.sellerPrice;
      item.actualPrice = 27500;
      return item;
    },
  };
  const editor = new Function(...Object.keys(context), code + '\nreturn { open, save, rubles };')(...Object.values(context));
  return { ...editor, requests };
}

test('staff enters 250 seller rubles; the form sends sellerPrice and reopens at 250, never at customer 275', async () => {
  const item = { price: 24200, actualPrice: null, actualSellerPrice: null };
  const editor = await priceEditor(item);
  editor.open();
  assert.equal(editor.rubles.value, '');
  editor.rubles.value = '250';
  await editor.save();
  assert.equal(editor.requests[0].body.sellerPrice, 25000);
  assert.ok(!Object.hasOwn(editor.requests[0].body, 'price'));
  assert.ok(!Object.hasOwn(editor.requests[0].body, 'actualPrice'));
  editor.open();
  assert.equal(editor.rubles.value, '250.00');
  await editor.save();
  assert.equal(editor.requests[1].body.sellerPrice, 25000);
  assert.equal(item.actualPrice, 27500);
});

test('a historical customer correction without a known seller input is never reused as sellerPrice', async () => {
  const editor = await priceEditor({ price: 24200, actualPrice: 27500 });
  editor.open();
  assert.equal(editor.rubles.value, '');
});
