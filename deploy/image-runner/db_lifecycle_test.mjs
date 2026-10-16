import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('./db_lifecycle.mjs', import.meta.url));
const poison = 'postgresql://fixture:never-print-this@127.0.0.1:1/forbidden';
function run(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 3000,
    env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, DATABASE_URL: poison } });
}
test('plan succeeds without an artifact or DB and never emits inherited credentials', () => {
  const result = run(['--plan']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'PREPARED_NOT_RUN');
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.includes('never-print-this'), false);
});
test('unknown mode fails before imports or DB access', () => {
  const result = run(['--production']);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.includes('never-print-this'), false);
});
test('run mode refuses an ordinary host with inherited DB configuration', () => {
  const result = run(['--close']);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.includes('never-print-this'), false);
});
