import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { effectScope, h, ref, createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { productImageAttrs, productImageSizes, productImageVariantsEnabled } from '../app/utils/product-image.ts';
import { useAsset } from '../app/composables/useAsset.ts';
import { useProductGallery } from '../app/composables/useProductGallery.ts';
import { imageComposable, imageComponent } from './fixtures/product-image-view.mjs';
import { productImageFixture } from './fixtures/product-images.mjs';

const id = '550e8400-e29b-41d4-a716-000000000001';
const source = '/uploads/products/' + id + '.webp';
const candidate = (bound, width = bound, height = width) => ({
  url: '/uploads/products/variants/v1/' + id + '/' + 'a'.repeat(64) + '/' + bound + '.webp', width, height,
});
const image = (entries = [candidate(192), candidate(384), candidate(640)]) => ({
  url: source, alt: 'Фото', width: 1024, height: 1024, variants: { version: 'v1', webp: entries },
});
const asset = url => new URL(url, 'http://127.0.0.1:4001/api').href;
const attrs = (value = image(), context = 'card', enabled = true) => productImageAttrs(value, asset, context, enabled);

test('legacy images, missing images and disabled flags preserve the original URL/attributes', () => {
  assert.deepEqual(attrs({ url: source, alt: null }), { src: asset(source) });
  assert.deepEqual(attrs(image(), 'card', false), { src: asset(source) });
  assert.deepEqual(attrs(null), {});
  assert.deepEqual(attrs({ url: '', alt: null }), {});
  for (const value of [false, undefined, 'false', 'TRUE', 1, '1', null]) assert.equal(productImageVariantsEnabled(value), false);
  for (const value of [true, 'true']) assert.equal(productImageVariantsEnabled(value), true);
});

test('full candidates sort by actual width, resolve every URL and include the known original', () => {
  const result = attrs(image([candidate(640), candidate(192), candidate(384)]));
  assert.equal(result.src, asset(source));
  assert.equal(result.srcset, [192, 384, 640].map(width => asset(candidate(width).url) + ' ' + width + 'w').concat(asset(source) + ' 1024w').join(', '));
  assert.ok(!result.srcset.includes('2x'));
  assert.ok(!result.sizes.includes('var('));
});

test('partial candidates remain usable without inventing missing profiles', () => {
  const result = attrs(image([candidate(192), candidate(384)]));
  assert.ok(result.srcset.includes('192w') && result.srcset.includes('384w'));
  assert.ok(!result.srcset.includes('640w'));
});

test('deduplicates equal actual widths instead of using file bounds as descriptors', () => {
  const value = { ...image(), width: 1, height: 1024,
    variants: { version: 'v1', webp: [candidate(192, 1, 192), candidate(384, 1, 384), candidate(640, 1, 640)] } };
  assert.equal(attrs(value).srcset, asset(source) + ' 1w');
});

test('portrait, square and wide photographs retain enough resolution to cover a 4:3 card', () => {
  const value = { ...image(), width: 512, height: 1024,
    variants: { version: 'v1', webp: [candidate(192, 96, 192), candidate(384, 192, 384), candidate(640, 320, 640)] } };
  assert.match(attrs(value).srcset, /96w, .*192w, .*320w, .*512w/);
  assert.equal(attrs(value).sizes, productImageSizes('card'));
  assert.equal(attrs(value, 'compact').sizes, productImageSizes('card'));
  assert.equal(attrs(image(), 'compact').sizes, productImageSizes('card'));
  const wide = { ...image([candidate(192, 192, 96)]), width: 1024, height: 512 };
  assert.match(attrs(wide).sizes, /\* 1\.5\)/);
  assert.equal(attrs(wide, 'compact').sizes, attrs(wide).sizes);
  assert.equal(attrs(value, 'thumbnail').sizes, 'calc(3.6rem - 4px)');
  assert.match(attrs({ ...image([candidate(192, 192, 96)]), width: 1024, height: 512 }, 'thumbnail').sizes, /\* 2\)/);
});

test('tiny originals win equal-width duplicates without fictitious upscaling', () => {
  const value = { ...image([candidate(192, 72, 48)]), width: 72, height: 48 };
  assert.equal(attrs(value).srcset, asset(source) + ' 72w');
});

test('never fabricates an original width when dimensions are missing', () => {
  const value = image();
  delete value.width; delete value.height;
  const result = attrs(value);
  assert.ok(result.srcset.includes('192w'));
  assert.ok(!result.srcset.includes(asset(source) + ' '));
});

for (const [name, mutate] of [
  ['unknown version', value => { value.variants.version = 'v2'; }],
  ['empty candidates', value => { value.variants.webp = []; }],
  ['oversized candidate list', value => { value.variants.webp = Array(4).fill(candidate(192)); }],
  ['null metadata', value => { value.variants = null; }],
  ['external URL', value => { value.variants.webp = [{ ...candidate(192), url: 'https://example.com/a.webp' }]; }],
  ['traversal', value => { value.variants.webp = [{ ...candidate(192), url: candidate(192).url.replace('/v1/', '/../v1/') }]; }],
  ['query', value => { value.variants.webp = [{ ...candidate(192), url: candidate(192).url + '?x=1' }]; }],
  ['wrong original', value => { value.url = '/uploads/products/not-managed.webp'; }],
  ['different source hashes', value => { value.variants.webp[1].url = candidate(384).url.replace('a'.repeat(64), 'b'.repeat(64)); }],
  ['invalid dimensions', value => { value.variants.webp = [candidate(192, NaN, 192)]; }],
  ['invalid original dimensions', value => { value.width = NaN; }],
  ['inflated width', value => { value.variants.webp = [candidate(192, 384, 192)]; }],
  ['wrong aspect ratio', value => { value.variants.webp = [candidate(192, 192, 100)]; }],
  ['newline', value => { value.variants.webp = [{ ...candidate(192), url: candidate(192).url + '\n' }]; }],
]) test('rejects malformed metadata: ' + name, () => {
  const value = image(); mutate(value);
  assert.deepEqual(attrs(value), { src: asset(value.url) });
});

test('a bad slot cannot turn a remaining verified candidate into a fake profile', () => {
  const value = image([candidate(192), { ...candidate(384), width: -1 }]);
  assert.match(attrs(value).srcset, /192w, .*1024w/);
});

test('sizes reflect every real column/gap, container cap, border and coarse landscape override', () => {
  const sizes = productImageSizes('card');
  for (const breakpoint of [40, 48, 64, 80, 96]) assert.ok(sizes.includes('(min-width: ' + breakpoint + 'rem)'));
  assert.ok(sizes.includes('min(100vw, 80rem)'));
  for (const columns of [2, 3, 4, 5, 6, 7]) assert.ok(sizes.includes('/ ' + columns + ' - 2px'));
  assert.ok(sizes.includes('(pointer: coarse)') && sizes.includes('- 2 * 1rem'));
  assert.equal(productImageSizes('thumbnail'), 'calc(3.6rem - 4px)');
});

test('high-DPR cards retain the native original as the larger candidate; gallery main stays original', () => {
  assert.ok(attrs().srcset.endsWith('1024w'));
  assert.deepEqual(attrs(image(), 'original'), { src: asset(source) });
});

test('the real useAsset resolves upload candidates against the API origin without changing other assets', () => {
  const previous = globalThis.useRuntimeConfig;
  globalThis.useRuntimeConfig = () => ({ public: { apiBase: 'http://127.0.0.1:4567/api' } });
  try {
    const resolveAsset = useAsset();
    assert.equal(resolveAsset(source), 'http://127.0.0.1:4567' + source);
    assert.equal(resolveAsset(candidate(192).url), 'http://127.0.0.1:4567' + candidate(192).url);
    assert.equal(resolveAsset('/images/legacy.webp'), '/images/legacy.webp');
    assert.equal(resolveAsset('https://example.com/a.webp'), 'https://example.com/a.webp');
  } finally { globalThis.useRuntimeConfig = previous; }
});

test('one variant error retries original once, ignores stale callbacks and ends at a safe placeholder', async () => {
  const useImage = await imageComposable({ enabled: true, asset });
  const scope = effectScope();
  const photo = scope.run(() => useImage(() => image(), () => 'card', () => 1));
  try {
    const first = photo.attrs.value;
    first.onError();
    const retry = photo.attrs.value;
    assert.equal(retry.src, asset(source));
    assert.equal(retry.srcset, undefined);
    assert.equal(retry.sizes, undefined);
    assert.notEqual(retry.key, first.key);
    first.onError();
    assert.equal(photo.failed.value, false);
    retry.onError();
    assert.equal(photo.failed.value, true);
    retry.onError();
    assert.equal(photo.failed.value, true);
  } finally { scope.stop(); }
});

test('a legacy/original failure goes straight to placeholder without a retry loop', async () => {
  const useImage = await imageComposable();
  const scope = effectScope();
  const photo = scope.run(() => useImage(() => ({ url: source, alt: null }), () => 'card', () => 1));
  photo.attrs.value.onError();
  assert.equal(photo.failed.value, true);
  scope.stop();
});

test('product/URL changes reset error state synchronously, even when the image object is reused', async () => {
  const useImage = await imageComposable({ enabled: true });
  const value = ref(image()), identity = ref(1), scope = effectScope();
  const photo = scope.run(() => useImage(() => value.value, () => 'card', () => identity.value));
  try {
    const stale = photo.attrs.value;
    stale.onError(); photo.attrs.value.onError();
    identity.value = 2;
    assert.equal(photo.failed.value, false);
    assert.ok(photo.attrs.value.srcset);
    stale.onError();
    assert.equal(photo.failed.value, false);
    value.value.url = '/uploads/products/550e8400-e29b-41d4-a716-000000000002.webp';
    assert.equal(photo.attrs.value.src, value.value.url);
    assert.equal(photo.failed.value, false);
  } finally { scope.stop(); }
});

test('gallery switching updates source/metadata and resets failure, including duplicate image URLs', async () => {
  const useImage = await imageComposable({ enabled: true });
  const shared = image(), images = ref([shared, shared]), scope = effectScope();
  const state = scope.run(() => {
    const gallery = useProductGallery(() => images.value);
    return { gallery, photo: useImage(() => gallery.current.value, () => 'original', () => gallery.selected.value) };
  });
  try {
    state.photo.attrs.value.onError();
    assert.equal(state.photo.failed.value, true);
    state.gallery.select(1);
    assert.equal(state.photo.failed.value, false);
    images.value = [image([candidate(192)])];
    assert.equal(state.photo.failed.value, false);
  } finally { scope.stop(); }
});

test('SSR preserves lazy loading independently of the responsive flag and emits deterministic srcset', async () => {
  for (const enabled of [false, true]) {
    const component = await imageComponent(await imageComposable({ enabled, asset }));
    const render = () => renderToString(createSSRApp({ render: () => h(component,
      { image: image(), alt: 'Фото', context: 'card' }, { default: () => h('span', 'Фото скоро') }) }));
    const server = await render(), initialClient = await render();
    assert.equal(server, initialClient);
    assert.ok(server.includes('src="' + asset(source) + '"') && server.includes('alt="Фото"'));
    assert.equal(server.includes('srcset='), enabled);
    assert.equal(server.includes('sizes='), enabled);
    assert.ok(server.includes('decoding="async"'));
    assert.ok(server.includes('loading="lazy"') && server.includes('fetchpriority="auto"'));
  }
});

test('local real photographs use stage 3A verified metadata, including portrait and tiny originals', async () => {
  const fixture = await productImageFixture();
  try {
    for (const value of fixture.images) {
      const result = attrs(value);
      assert.ok(result.srcset);
      assert.equal(result.src, asset(value.url));
      for (const entry of value.variants.webp) assert.ok(result.srcset.includes(' ' + entry.width + 'w'));
    }
    assert.ok(fixture.images[1].height > fixture.images[1].width);
    assert.equal(fixture.images[2].width, 72);
  } finally { await fixture.close(); }
});

test('catalog, home and favorites use the shared grid with bounded initial priority and unchanged layout', async () => {
  const source = file => readFile(new URL('../app/' + file, import.meta.url), 'utf8');
  const [home, favorites, catalog, grid, card, gallery] = await Promise.all([
    source('pages/index.vue'), source('pages/favorites.vue'), source('components/catalog/View.vue'),
    source('components/product/Grid.vue'), source('components/product/Card.vue'), source('components/product/Gallery.vue'),
  ]);
  for (const page of [home, favorites, catalog]) assert.ok(page.includes('<ProductGrid'));
  assert.match(favorites, /compact/);
  assert.match(grid, /:key="product.id"/);
  assert.match(grid, /:data-product-index="start \+ index"/);
  assert.match(card, /:eager-image="eagerImage"/);
  assert.match(grid, /eagerImages && start \+ index < 4/);
  assert.match(card, /object-fit: cover/);
  assert.match(gallery, /context="original"/);
  assert.match(gallery, /loading="lazy"/);
});
