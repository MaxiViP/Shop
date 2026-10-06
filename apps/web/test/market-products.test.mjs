import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { parse, compileScript } from 'vue/compiler-sfc';
import { createSSRApp, defineComponent, h, ref, reactive, computed, watch, nextTick } from 'vue';
import { renderToString } from 'vue/server-renderer';
import ts from 'typescript';
import * as money from '../app/utils/money.ts';
import * as quantity from '../app/utils/assembly.ts';
import { qtyText } from '../app/utils/qty.ts';
import { quickAddState } from '../app/utils/quick-add.ts';
import { nextCartQty, previousCartQty, previewTotal, validCartQty } from '../app/utils/cart.ts';

const nodeRequire = createRequire(import.meta.url);
const source = file => readFile(new URL(`../app/${file}`, import.meta.url), 'utf8');
const product = { id: 1, name: 'Рис Casa Rinaldi Карнароли 500 г', slug: 'cezoni-market-casa-rinaldi-carnaroli-500g',
  price: 24200, priceQty: 1, unit: 'PIECE', step: 1, min: 1, portionQty: 1, images: [], description: null,
  category: { name: 'Макароны и крупы', slug: 'pasta-grains' }, marketPoint: { name: 'Cezoni Market', slug: 'cezoni-market' } };
const cart = { restored: true, serverBusy: false, quoteReady: true, items: [], qty: () => 0, displayLineTotal: () => null };

const modules = {
  '~/utils/money': money,
  '~/utils/qty': { qtyText },
  '~/utils/quick-add': { quickAddState },
  '~/utils/cart': { nextCartQty, previousCartQty, previewTotal, validCartQty },
  '~/stores/cart': { useCartStore: () => cart },
  '~/utils/seo': { breadcrumbSchema() {}, productSchema() {}, productSeo() {} },
};
async function component(file) {
  const { descriptor } = parse(await source(file), { filename: file });
  const compiled = compileScript(descriptor, { id: file, inlineTemplate: true });
  const code = ts.transpileModule(compiled.content, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  const context = { require: id => modules[id] ?? nodeRequire(id), exports: module.exports, module,
    computed, ref, watch, useRoute: () => ({ params: { slug: product.slug } }),
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
const Detail = await component('pages/product/[slug].vue');
const wrapper = defineComponent({ setup: (_, { slots }) => () => h('div', slots.default?.()) });
const link = defineComponent({ props: ['to'], setup: (props, { slots }) => () => h('a', { href: props.to }, slots.default?.()) });
async function render(Component, props = {}) {
  const app = createSSRApp(Component, props);
  app.component('NuxtLink', link);
  app.component('ProductOrigin', Origin);
  app.component('ProductPrice', Price);
  for (const name of ['UButton', 'UContainer', 'UAlert', 'UIcon', 'ProductFavorite', 'ProductGallery', 'ProductQty', 'AppBreadcrumbs', 'AppBackButton'])
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
  assert.ok(html.includes('Цена ориентировочная. Актуальную цену продавец подтвердит при сборке.'));
  assert.ok(!html.includes('sourceUrl') && !html.includes('220 ₽') && !html.includes('role="alert"'));
});

test('product detail renders the same customer price, purchase total and market point link', async () => {
  const html = await render(Detail);
  assert.ok(html.includes(product.name));
  assert.ok(html.includes('В корзину · 242 ₽'));
  assert.match(html, /href="\/market-map\/cezoni-market"/);
  assert.ok(html.includes('Цена ориентировочная. Актуальную цену продавец подтвердит при сборке.'));
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
  const context = { ref, reactive, computed, ...money, ...quantity, qtyText,
    defineProps: () => ({ product: admin, categories: [{ id: 1, name: 'Макароны и крупы', active: true }] }),
    defineEmits: () => () => {},
    watch: (...args) => { const stop = watch(...args); stops.push(stop); return stop; },
    useApi: async path => {
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
