import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'vitest';
import { inspectLauncherAdmission, inspectLauncherDryRunHandoff } from './admission.js';
import { RunnerError } from './model.js';
import type { Options } from './options.js';
import { runProduction } from './runner.js';

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

test('inspection-only handoff cannot be fabricated by an ordinary process', () => {
  assert.throws(() => inspectLauncherDryRunHandoff({ ...options, apply: false }),
    (error: unknown) => error instanceof RunnerError && error.code === 'SANDBOX_UNVERIFIED');
});

test('inspection-only handoff never accepts apply options', () => {
  assert.throws(() => inspectLauncherDryRunHandoff(options),
    (error: unknown) => error instanceof RunnerError && error.code === 'SANDBOX_UNVERIFIED');
});

test('the production writer refuses direct calls before opening missing inputs', async () => {
  const input = { ...options };
  for (const key of ['inventory', 'sourceRoot', 'variantsRoot', 'stateRoot', 'approval'] as const)
    input[key] = resolve(input[key]!);
  await assert.rejects(runProduction(input),
    (error: unknown) => error instanceof RunnerError && error.code === 'SANDBOX_UNVERIFIED');
});
