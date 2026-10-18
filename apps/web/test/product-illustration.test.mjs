import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { productIllustration } from '../app/utils/product-illustration.ts';
import { photoOrigins } from '../../api/src/product/photo-origins.ts';

for (const batch of ['2026-10-07', '2026-10-18/pack']) {
  const manifest = JSON.parse(await readFile(new URL(`../../api/data/product-photos/${batch}/manifest.json`, import.meta.url)));
  test(`every ${batch} manifest image has exact product provenance`, () => {
    for (const row of manifest.products) {
      const bytes = createHash('sha256').update(`KorzinaMarket:AI_PLACEHOLDER:${manifest.batch}:${row.slug}:${row.sha256}`).digest();
      bytes[6] = (bytes[6] & 15) | 128; bytes[8] = (bytes[8] & 63) | 128;
      const id = bytes.subarray(0, 16).toString('hex');
      const url = `/uploads/products/${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}.webp`;
      assert.equal(photoOrigins[url], row.slug);
      assert.equal(productIllustration({ url, alt: null }), true);
    }
  });
}
test('editable alt, external URLs and UUID version alone never identify an illustration', () => {
  for (const image of [undefined, null, { url: '__proto__' }, { url: 'https://example.org/photo.webp', alt: 'Иллюстрация товара' },
    { url: '/uploads/products/00000000-0000-8000-8000-000000000000.webp', alt: 'Иллюстрация товара' }]) {
    assert.equal(productIllustration(image), false);
  }
});
