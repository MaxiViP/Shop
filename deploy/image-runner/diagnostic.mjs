// Fixed synthetic profiling only: the real encoder's default budgets are unchanged.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire('/artifact/apps/api/package.json');
const sharp = require('sharp');
const start = performance.now();
const { supervisedEncode } = await import('/artifact/apps/api/data/product-image-variants/encoder.ts');
const { generateImageVariants } = await import('/artifact/apps/api/src/product/image-variants.ts');
const importMs = performance.now() - start;
sharp.concurrency(1);
sharp.cache({ memory: 32, files: 0, items: 50 });
const input = await sharp({ create: { width: 800, height: 600, channels: 3,
  background: '#2468ac' } }).png().toBuffer();
const samples = [];
let outcome;
let supervised;
const began = performance.now();
try {
  supervised = await supervisedEncode(input, value => samples.push({ wallMs: performance.now() - began, ...value }));
  outcome = 'SUCCESS';
} catch (error) {
  assert.equal(error.code, 'TIMEOUT');
  outcome = 'TIMEOUT';
}
const supervisedMs = performance.now() - began;
const directBegan = performance.now();
const direct = await generateImageVariants(input);
const hashes = direct.variants.map(item => item.sha256);
if (supervised) assert.deepEqual(supervised.variants.map(item => item.sha256), hashes);
console.log('ENCODE_DIAGNOSTIC=' + JSON.stringify({ outcome, input: { width: 800, height: 600 },
  importMs, supervisedMs, timeoutMs: 30000, rssBytes: 512 * 1024 * 1024,
  firstUsage: samples[0] ?? null, lastUsage: samples.at(-1) ?? null, samples: samples.length,
  directMs: performance.now() - directBegan, hashes, productionApply: 'SANDBOX_UNVERIFIED' }));
