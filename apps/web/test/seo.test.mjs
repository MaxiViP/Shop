import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

function source(path) {
  return stripTypeScriptTypes(readFileSync(new URL(path, import.meta.url), 'utf8'))
    .replace(/^import .+;\r?$/gm, '').replace(/\bexport (?=(?:const|function|interface))/g, '');
}
const delivery = new Function(source('../app/utils/delivery.ts') + '\nreturn deliveryProvider;')();
const siteModule = new Function('deliveryProvider', source('../shared/utils/site.ts')
  + '\nreturn { site, canonicalUrl, isPublicPage, pageRobots };')(delivery);
const { site, canonicalUrl, pageRobots } = siteModule;
const seo = new Function('site', 'canonicalUrl', source('../app/utils/seo.ts')
  + '\nreturn { categorySeo, productSeo, productSchema, breadcrumbSchema, storeSchema, serializeJsonLd };')(site, canonicalUrl);

test('canonical domain and query normalization cannot inherit request hosts', () => {
  assert.equal(canonicalUrl('/catalog/future/?sort=price_desc&utm_source=test'), site.url + '/catalog/future');
  assert.equal(canonicalUrl('/'), site.url + '/');
  assert.equal(new URL(canonicalUrl('//evil.example/catalog')).origin, site.url);
});

test('private routes and filtered catalog are noindex; tracking URLs keep canonical public content', () => {
  for (const path of ['/cart', '/checkout', '/profile', '/orders', '/order/1', '/track/token', '/admin/login', '/staff/orders', '/favorites']) {
    assert.equal(pageRobots(path), 'noindex, follow', path);
  }
  assert.equal(pageRobots('/catalog/new-category'), 'index, follow');
  assert.equal(pageRobots('/catalog', { sort: 'price_asc' }), 'noindex, follow');
  assert.equal(pageRobots('/catalog', { q: 'test' }), 'noindex, follow');
  assert.equal(pageRobots('/catalog', { utm_source: 'test' }), 'index, follow');
});

test('future categories work without slug-specific mappings and overrides take precedence', () => {
  const category = { id: 101, slug: 'future-seafood', name: '\u041c\u043e\u0440\u0435\u043f\u0440\u043e\u0434\u0443\u043a\u0442\u044b' };
  assert.ok(seo.categorySeo(category).title.startsWith(category.name));
  assert.match(seo.categorySeo(category).title, /KorzinaMarket/);
  assert.equal(seo.categorySeo({ ...category, seoTitle: 'Custom title', seoDescription: 'Custom description' }).description, 'Custom description');
  assert.ok(site.title.includes('\u041c\u043e\u0441\u043a\u0432\u0435'));
  assert.ok(!site.description.includes('???'));
});

const product = {
  id: 10, slug: 'future-product', name: 'Future product', description: null,
  price: 12345, priceQty: 1000, unit: 'GRAM', min: 500, step: 100, portionQty: 500,
  category: { name: 'Future category', slug: 'future-category' },
  images: [{ url: '/uploads/products/image.webp', alt: null }],
};

test('Product Offer uses API price and reference unit, without fake inventory or ratings', () => {
  const value = seo.productSchema(product);
  assert.equal(value.offers.price, '123.45');
  assert.equal(value.offers.priceCurrency, 'RUB');
  assert.equal(value.offers.priceSpecification.referenceQuantity.value, 1000);
  assert.equal(value.offers.priceSpecification.referenceQuantity.unitCode, 'GRM');
  assert.equal(value.image[0], site.url + product.images[0].url);
  assert.equal(value.offers.availability, undefined);
  assert.equal(value.aggregateRating, undefined);
  assert.equal(value.offers.shippingDetails, undefined);
  assert.equal(seo.productSeo({ ...product, seoTitle: 'Override' }).title, 'Override');
});

test('JSON-LD safely serializes administrator text without ending the script', () => {
  const input = { name: '</script><script>alert(1)</script>' };
  const json = seo.serializeJsonLd(input);
  assert.ok(!json.includes('<'));
  assert.deepEqual(JSON.parse(json), input);
});

test('store schema uses confirmed geography without invented contact or reviews', () => {
  const store = seo.storeSchema()['@graph'][1];
  assert.equal(store['@type'], 'OnlineStore');
  assert.equal(store.areaServed.length, 3);
  for (const key of ['telephone', 'address', 'aggregateRating', 'openingHours', 'sameAs']) assert.equal(store[key], undefined);
});

function sitemap(fetcher) {
  let code = source('../server/routes/sitemap.xml.get.ts').replace('export default ', 'const handler = ');
  return new Function('$fetch', 'canonicalUrl', 'defineCachedEventHandler', 'useRuntimeConfig', 'setResponseHeader', 'createError',
    code + '\nreturn handler;')(fetcher, canonicalUrl, fn => fn,
    () => ({ public: { apiBase: 'http://127.0.0.1:4001/api' } }),
    () => {}, data => Object.assign(new Error(data.statusMessage), data));
}

test('sitemap discovers products beyond first page and excludes indexable=false', async () => {
  const calls = [];
  const handler = sitemap(async (path, options) => {
    if (path === '/categories') return [
      { slug: 'future-category', indexable: true }, { slug: 'hidden', indexable: false },
    ];
    const page = options.query.page;
    calls.push(page);
    return { total: 121, pages: 3, items: [
      { slug: 'product-' + page }, { slug: 'hidden-' + page, indexable: false },
    ] };
  });
  const xml = await handler({});
  assert.deepEqual(calls, [1, 2, 3]);
  for (const slug of ['future-category', 'product-1', 'product-2', 'product-3']) assert.ok(xml.includes(slug));
  assert.ok(!xml.includes('hidden'));
  for (const text of ['/cart', 'changefreq', 'priority', 'lastmod']) assert.ok(!xml.includes(text));
});

test('sitemap fails with 503 on API outage or excessive pages rather than serving incomplete XML', async () => {
  await assert.rejects(sitemap(async () => { throw new Error('API down'); })({}), { statusCode: 503 });
  await assert.rejects(sitemap(async path => path === '/categories' ? [] : { total: 1, pages: 999999 })({}), { statusCode: 503 });
});
