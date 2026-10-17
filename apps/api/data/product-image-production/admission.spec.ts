import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectLauncherAdmission } from './admission.js';
import { RunnerError } from './model.js';
import type { Options } from './options.js';

const options: Options = {
  apply: true,
  inventory: '/input/inventory.jsonl',
  sourceRoot: '/storage/products',
  variantsRoot: '/storage/product-variants',
  stateRoot: '/storage/.product-image-state',
  batchSize: 1,
  approval: '/input/approval.json',
  approvalSha256: '0'.repeat(64),
};

test('ordinary invocation cannot fabricate launcher admission', () => {
  assert.throws(() => inspectLauncherAdmission(options),
    (error: unknown) => error instanceof RunnerError && error.code === 'SANDBOX_UNVERIFIED');
});

test('arbitrary storage paths are not accepted', () => {
  assert.throws(() => inspectLauncherAdmission({ ...options, variantsRoot: '/tmp/variants' }),
    (error: unknown) => error instanceof RunnerError && error.code === 'SANDBOX_UNVERIFIED');
});
